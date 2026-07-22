import type { OcrEngine, OcrWord } from "@nova/context-engine/visual-redaction";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { Jimp, JimpMime } from "jimp";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { S3ObjectStore } from "../../src/media/object-store.js";
import { runSmoke } from "../../src/ops/smoke.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M18A.3 §6 — the REAL end-to-end recovery orchestration against real Postgres
 * + real MinIO. Unlike the fake-runner gate unit tests, this exercises the
 * ACTUAL restore.sh (authorized-scratch guard), the ACTUAL sealed off-box
 * publish/fetch, the ACTUAL S3 media restore + media:verify in the CORRECTED
 * order, and a real restored HTTP stack + smoke. It proves: scratch-only
 * restore, primary DB + primary/backup buckets unchanged, no plaintext in the
 * published set, and (the M18A.3 §2 fix) that media:verify FAILS before the
 * media restore and PASSES only after. Synthetic data only; no external infra.
 */
const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const databaseUrl = process.env.DATABASE_URL;
const S3_ENDPOINT = process.env.NOVA_TEST_S3_ENDPOINT ?? "http://127.0.0.1:9000";
const S3_KEY = process.env.NOVA_TEST_S3_ACCESS_KEY_ID ?? "nova";
const S3_SECRET = process.env.NOVA_TEST_S3_SECRET_ACCESS_KEY ?? "nova-minio-secret";

const s3Required = process.env.NOVA_TEST_S3_REQUIRED === "yes";
const s3Available = await (async () => {
  try {
    return (await fetch(`${S3_ENDPOINT}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
})();
if (s3Required && (!databaseUrl || !s3Available)) {
  describe("M18A.3 §6: real recovery e2e (REQUIRED)", () => {
    it("Postgres + MinIO must be available when NOVA_TEST_S3_REQUIRED=yes", () => {
      throw new Error(`NOVA_TEST_S3_REQUIRED=yes but e2e cannot run: db=${!!databaseUrl}, minio=${s3Available}`);
    });
  });
}

const RUN = Date.now().toString(36);
const KEY_HEX = randomBytes(32).toString("hex");
const BACKUP_KEY = randomBytes(32).toString("hex");
const dirs: string[] = [];

class FakeOcr implements OcrEngine {
  readonly name = "fake";
  async recognize(): Promise<{ words: OcrWord[] }> {
    return { words: [{ text: "hello", x0: 0, y0: 0, x1: 50, y1: 20 }] };
  }
}
async function whitePng(): Promise<string> {
  const img = new Jimp({ width: 400, height: 120, color: 0xffffffff });
  return `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;
}
function store(bucket: string) {
  return new S3ObjectStore({ bucket, region: "us-east-1", endpoint: S3_ENDPOINT, accessKeyId: S3_KEY, secretAccessKey: S3_SECRET });
}
async function s3Admin() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({ region: "us-east-1", endpoint: S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET } });
}
async function listKeys(bucket: string): Promise<string[]> {
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const out: string[] = [];
  let token: string | undefined;
  do {
    const r = await (await s3Admin()).send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of r.Contents ?? []) out.push(o.Key!);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out.sort();
}
async function destroyBucket(bucket: string) {
  const { DeleteBucketCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const c = await s3Admin();
  for (const k of await listKeys(bucket)) await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: k }));
  await c.send(new DeleteBucketCommand({ Bucket: bucket }));
}

const s3Env = (over: Record<string, string>) => ({
  ...process.env,
  NOVA_BACKUP_KEY: BACKUP_KEY,
  NOVA_ENCRYPTION_KEY: KEY_HEX,
  NOVA_MEDIA_STORE: "s3",
  NOVA_MEDIA_S3_ENDPOINT: S3_ENDPOINT,
  NOVA_MEDIA_S3_ACCESS_KEY_ID: S3_KEY,
  NOVA_MEDIA_S3_SECRET_ACCESS_KEY: S3_SECRET,
  NOVA_BACKUP_S3_ENDPOINT: S3_ENDPOINT,
  NOVA_BACKUP_S3_ACCESS_KEY_ID: S3_KEY,
  NOVA_BACKUP_S3_SECRET_ACCESS_KEY: S3_SECRET,
  ...over,
});
async function pnpmApi(script: string, args: string[], env: Record<string, string>) {
  try {
    const { stdout, stderr } = await execFileAsync(
      "pnpm",
      ["--filter", "@nova/api", "--silent", script, "--", ...args],
      { cwd: repoRoot, env: s3Env(env) },
    );
    return { code: 0, out: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

describe.skipIf(!databaseUrl || !s3Available)("M18A.3 §6: real recovery orchestration e2e", () => {
  const PRIMARY = `nova-m18a3-primary-${RUN}`;
  const BACKUP = `nova-m18a3-backup-${RUN}`;
  const SCRATCH = `nova-m18a3-scratch-${RUN}`;
  // A DEDICATED primary database — never the shared dev DB. media:backup-s3
  // backs up EVERY moment_media row globally (correct production semantics), so
  // the primary store must hold every blob the DB references. The shared dev DB
  // accumulates thousands of rows from other test runs pointing at long-gone
  // buckets; isolating to a fresh DB makes the global inventory query honest.
  const primaryDbName = `nova_m18a3_primary_${RUN}`;
  const scratchDbName = `nova_m18a3_scratch_${RUN}`;
  const EMAIL = `m18a3-e2e-${RUN}@test.local`;
  let app: FastifyInstance;
  let scratchApp: FastifyInstance | null = null;
  let db: pg.Pool;
  let scratchDb: pg.Pool | null = null;
  let primaryUrl = "";
  let scratchUrl = "";
  let user: TestUser;
  let stamp = "";
  let fetchDir = "";
  let primaryKeysBefore: string[] = [];
  let backupKeysAfterPublish: string[] = [];

  beforeAll(async () => {
    const { CreateBucketCommand } = await import("@aws-sdk/client-s3");
    const c = await s3Admin();
    for (const b of [PRIMARY, BACKUP, SCRATCH]) await c.send(new CreateBucketCommand({ Bucket: b }));
    // Fresh, isolated primary database (loopback → local_scratch under the same
    // guard the gate uses) so the media inventory only ever sees this run's rows.
    const admin0 = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin0.query(`DROP DATABASE IF EXISTS ${primaryDbName}`);
    await admin0.query(`CREATE DATABASE ${primaryDbName}`);
    await admin0.end();
    const pu = new URL(databaseUrl!);
    pu.pathname = `/${primaryDbName}`;
    primaryUrl = pu.toString();
    await migrate(primaryUrl);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: primaryUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_STORE: "s3",
        NOVA_MEDIA_S3_BUCKET: PRIMARY,
        NOVA_MEDIA_S3_ENDPOINT: S3_ENDPOINT,
        NOVA_MEDIA_S3_ACCESS_KEY_ID: S3_KEY,
        NOVA_MEDIA_S3_SECRET_ACCESS_KEY: S3_SECRET,
      }),
      ocr: new FakeOcr(),
      objectStore: store(PRIMARY),
    });
    await app.ready();
    db = new pg.Pool({ connectionString: primaryUrl, max: 5 });
    user = await createUser(app, EMAIL);
    for (let i = 0; i < 2; i++) {
      const res = await user.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: {
          source_mode: "instant_capture",
          source_meta: { url: `https://m18a3.example.com/p${i}`, title: `M18A3 ${i}` },
          payload: { screenshot_data_url: await whitePng() },
          extracted_text: `m18a3 e2e ${i}`,
          intent_text: null,
        },
      });
      expect(res.statusCode).toBe(201);
    }
    primaryKeysBefore = await listKeys(PRIMARY);
    expect(primaryKeysBefore.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  afterAll(async () => {
    await scratchApp?.close();
    await app?.close();
    await scratchDb?.end();
    await db?.end();
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    for (const name of [scratchDbName, primaryDbName]) {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [name]);
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    }
    await admin.end();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    for (const b of [PRIMARY, BACKUP, SCRATCH]) await destroyBucket(b).catch(() => {});
  }, 120_000);

  it("scripts/backup.sh seals + publishes off-box (durable completion) — no plaintext uploaded", async () => {
    const out = mkdtempSync(join(tmpdir(), "nova-e2e-bk-"));
    dirs.push(out);
    const { stdout, stderr } = await execFileAsync("bash", ["scripts/backup.sh", out], {
      cwd: repoRoot,
      env: s3Env({ DATABASE_URL: primaryUrl, NOVA_MEDIA_S3_BUCKET: PRIMARY, NOVA_BACKUP_S3_BUCKET: BACKUP, NOVA_BACKUP_PUBLISH_S3: "yes" }),
    });
    const log = `${stdout}\n${stderr}`;
    expect(log).toContain("Local sealed backup prepared");
    expect(log).toContain("Remote verification passed");
    expect(log).toContain("Backup complete and durable off-box");
    // Stamp from the sealed manifest filename.
    const manifest = readdirSync(out).find((f) => /^manifest-.*\.json$/.test(f))!;
    stamp = manifest.replace(/^manifest-(.*)\.json$/, "$1");
    expect(stamp).toBeTruthy();
    backupKeysAfterPublish = await listKeys(BACKUP);
    expect(backupKeysAfterPublish.some((k) => k === `sealed-backups/${stamp}/remote-marker.json`)).toBe(true);
    // No plaintext: the sealed DB object in the backup store must NOT contain
    // the plaintext account email (it is inside the AES-256-GCM dump).
    const sealed = await store(BACKUP).get(`sealed-backups/${stamp}/nova-db-${stamp}.dump.enc`);
    expect(sealed).not.toBeNull();
    expect(sealed!.includes(Buffer.from(EMAIL))).toBe(false);
    // Primary bucket untouched by the backup.
    expect(await listKeys(PRIMARY)).toEqual(primaryKeysBefore);
  }, 180_000);

  it("backup:fetch-s3 → real restore.sh (authorized-scratch) restores the DB into a scratch target only", async () => {
    // Scratch database (loopback → local_scratch under the same guard the gate uses).
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${scratchDbName}`);
    await admin.query(`CREATE DATABASE ${scratchDbName}`);
    await admin.end();
    const u = new URL(databaseUrl!);
    u.pathname = `/${scratchDbName}`;
    scratchUrl = u.toString();
    await migrate(scratchUrl);
    scratchDb = new pg.Pool({ connectionString: scratchUrl, max: 5 });

    fetchDir = mkdtempSync(join(tmpdir(), "nova-e2e-fetch-"));
    dirs.push(fetchDir);
    const fetched = await pnpmApi("backup:fetch-s3", [`--stamp=${stamp}`, `--out=${fetchDir}`], {
      DATABASE_URL: scratchUrl,
      NOVA_BACKUP_S3_BUCKET: BACKUP,
      // fetch only touches the BACKUP store, but loadEnv() still validates the
      // media config because s3Env sets NOVA_MEDIA_STORE=s3 — provide a bucket.
      NOVA_MEDIA_S3_BUCKET: SCRATCH,
    });
    expect(fetched.code).toBe(0);
    expect(fetched.out).toContain("SEALED BACKUP FETCH OK");

    // Real restore.sh in authorized-scratch mode → pg_restore into scratch only.
    const { stdout, stderr } = await execFileAsync("bash", ["scripts/restore.sh", fetchDir, stamp], {
      cwd: repoRoot,
      env: s3Env({ DATABASE_URL: scratchUrl, NOVA_RESTORE_MODE: "authorized-scratch", NOVA_RESTORE_CONFIRM: "RESTORE", NOVA_MEDIA_S3_BUCKET: SCRATCH }),
    });
    const log = `${stdout}\n${stderr}`;
    expect(log).toContain("mode: authorized-scratch");
    expect(log).toContain("restoring Postgres");
    // restore.sh must NOT run media:verify itself (that is the gate's job now).
    expect(log).not.toContain("every blob present AND decryptable with the data key:");

    const scratchUsers = await scratchDb.query("SELECT id FROM users WHERE email = $1", [EMAIL]);
    expect(scratchUsers.rowCount).toBe(1);
    const scratchMedia = await scratchDb.query(
      "SELECT count(*)::int AS n FROM moment_media mm JOIN context_moments m ON m.id = mm.moment_id WHERE m.user_id = $1",
      [user.userId],
    );
    expect(scratchMedia.rows[0].n).toBeGreaterThanOrEqual(2);
    // Primary DB unchanged.
    const primaryUsers = await db.query("SELECT count(*)::int AS n FROM users WHERE email = $1", [EMAIL]);
    expect(primaryUsers.rows[0].n).toBe(1);
  }, 180_000);

  it("CORRECTED ORDER (§2): media:verify FAILS before the media restore, PASSES only after", async () => {
    // The scratch DB now references media, but the scratch bucket is still
    // EMPTY — media:verify MUST fail (the old restore.sh ordering ran it here).
    const before = await pnpmApi("media:verify", [], { DATABASE_URL: scratchUrl, NOVA_MEDIA_S3_BUCKET: SCRATCH });
    expect(before.code).not.toBe(0);

    // Now restore media into the scratch bucket (the gate's media_restore_s3).
    const restore = await pnpmApi("media:restore-s3", [`--stamp=${stamp}`, `--dir=${fetchDir}`, "--apply"], {
      DATABASE_URL: scratchUrl,
      NOVA_MEDIA_S3_BUCKET: SCRATCH,
      NOVA_BACKUP_S3_BUCKET: BACKUP,
    });
    expect(restore.code).toBe(0);

    // media:verify now PASSES (every blob present AND decryptable).
    const after = await pnpmApi("media:verify", [], { DATABASE_URL: scratchUrl, NOVA_MEDIA_S3_BUCKET: SCRATCH });
    expect(after.code).toBe(0);

    // Primary + backup buckets are unchanged by the scratch restore.
    expect(await listKeys(PRIMARY)).toEqual(primaryKeysBefore);
    expect(await listKeys(BACKUP)).toEqual(backupKeysAfterPublish);
  }, 180_000);

  it("restored stack boots against scratch + real post-restore smoke passes", async () => {
    scratchApp = await buildApp({
      env: loadEnv({
        DATABASE_URL: scratchUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_STORE: "s3",
        NOVA_MEDIA_S3_BUCKET: SCRATCH,
        NOVA_MEDIA_S3_ENDPOINT: S3_ENDPOINT,
        NOVA_MEDIA_S3_ACCESS_KEY_ID: S3_KEY,
        NOVA_MEDIA_S3_SECRET_ACCESS_KEY: S3_SECRET,
      }),
      ocr: new FakeOcr(),
      objectStore: store(SCRATCH),
    });
    await scratchApp.listen({ port: 0, host: "127.0.0.1" });
    const addr = scratchApp.server.address() as { port: number };
    const { ok, steps } = await runSmoke(`http://127.0.0.1:${addr.port}`, {});
    const failed = steps.filter((s) => s.status === "fail").map((s) => s.step);
    expect(failed, `failed smoke steps: ${failed.join(", ")}`).toEqual([]);
    expect(ok).toBe(true);
    // M18A.4 P1-2: the smoke's own synthetic account must be ABSENT afterward —
    // it deletes itself through the real flow and proves the credentials dead.
    const smokeAccounts = await scratchDb!.query(
      "SELECT count(*)::int AS n FROM users WHERE email LIKE '%@alpha.local'",
    );
    expect(smokeAccounts.rows[0].n).toBe(0);
    // M18A.5 (NCA-17-002): no web OR extension/device session and no pairing
    // code survives the smoke — neither attached to a smoke user nor orphaned.
    const smokeSessions = await scratchDb!.query(
      `SELECT count(*)::int AS n FROM sessions s
         LEFT JOIN users u ON u.id = s.user_id
        WHERE u.id IS NULL OR u.email LIKE '%@alpha.local'`,
    );
    expect(smokeSessions.rows[0].n).toBe(0);
    const smokePairing = await scratchDb!.query(
      `SELECT count(*)::int AS n FROM pairing_codes p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE u.id IS NULL OR u.email LIKE '%@alpha.local'`,
    );
    expect(smokePairing.rows[0].n).toBe(0);
    // No token-like secret in the smoke's reported output.
    expect(JSON.stringify(steps)).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  }, 180_000);

  it("M18A.4 P1-1: the single `validate:recovery-remote` entrypoint runs green → exit 0, workspace removed", async () => {
    // The full off-box drill through ONE command against the committed set + the
    // already-restored+booted scratch stack. A successful gate + clean workspace
    // cleanup is the ONLY way this exits 0 (NCA-17-001).
    const addr = scratchApp!.server.address() as { port: number };
    const { stdout, stderr, code } = await execFileAsync(
      "pnpm",
      [
        "--filter",
        "@nova/validation-gate",
        "--silent",
        "recovery-remote",
        "--",
        `--stamp=${stamp}`,
        `--restored-base-url=http://127.0.0.1:${addr.port}`,
        "--invite=synthetic-recovery-invite",
      ],
      {
        cwd: repoRoot,
        env: s3Env({
          DATABASE_URL: scratchUrl,
          NOVA_MEDIA_S3_BUCKET: SCRATCH,
          NOVA_BACKUP_S3_BUCKET: BACKUP,
          NOVA_SMOKE_INVITE: "synthetic-recovery-invite",
        }),
      },
    )
      .then((r) => ({ ...r, code: 0 }))
      .catch((e: { code?: number; stdout?: string; stderr?: string }) => ({
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        code: e.code ?? 1,
      }));
    const log = `${stdout}\n${stderr}`;
    expect(log, log).toContain("remote_fetch: committed set fetched + verified");
    expect(log).toContain("remote_workspace_cleanup: temporary recovery workspace removed");
    expect(code).toBe(0);
  }, 300_000);
});
