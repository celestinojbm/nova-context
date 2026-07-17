import type { OcrEngine, OcrWord } from "@nova/context-engine/visual-redaction";
import { decryptBytesWithAny, parseEncryptionKey } from "@nova/context-engine/secret-box";
import type { FastifyInstance } from "fastify";
import { Jimp, JimpMime } from "jimp";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { S3ObjectStore } from "../../src/media/object-store.js";
import { runSmoke } from "../../src/ops/smoke.js";
import {
  backupMediaToStore,
  restoreMediaFromBackup,
  verifyMediaBackup,
  type MediaKeyRow,
  type StoreTarget,
} from "../../src/backup/media-s3.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M18A §2 — the complete media recovery sequence against a REAL S3 API
 * (MinIO locally; the identical client/path R2 uses in production), with no
 * external resources and synthetic data only:
 *
 *   primary bucket → backup bucket (+ authenticated inventory)
 *     → tamper/wrong-key proofs
 *     → scratch DATABASE restore (schema migrate + row copy; the sealed
 *       pg_dump/pg_restore path has its own coverage via scripts/restore.sh)
 *     → media restore into a separate SCRATCH bucket
 *     → media:verify equivalent over the scratch stack (present + decryptable)
 *     → MANDATORY post-restore synthetic smoke (the real runSmoke walk over
 *       HTTP against the scratch app)
 *     → primary/scratch separation proof → full local cleanup.
 *
 * Requires the dev MinIO (docker compose --profile media-s3 up -d minio) or
 * NOVA_TEST_S3_ENDPOINT; skips cleanly when unavailable.
 */

const databaseUrl = process.env.DATABASE_URL;
const S3_ENDPOINT = process.env.NOVA_TEST_S3_ENDPOINT ?? "http://127.0.0.1:9000";
const S3_KEY = process.env.NOVA_TEST_S3_ACCESS_KEY_ID ?? "nova";
const S3_SECRET = process.env.NOVA_TEST_S3_SECRET_ACCESS_KEY ?? "nova-minio-secret";

const s3Available = await (async () => {
  try {
    const res = await fetch(`${S3_ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
})();

const KEY_HEX = randomBytes(32).toString("hex");
const BACKUP_KEY = randomBytes(32);
const STAMP = `m18test-${Date.now()}`;
const RUN = Date.now().toString(36);

class FakeOcr implements OcrEngine {
  readonly name = "fake";
  async recognize(): Promise<{ words: OcrWord[] }> {
    return { words: [{ text: "hello", x0: 0, y0: 0, x1: 50, y1: 20 }] };
  }
}

async function whitePng(w = 400, h = 120): Promise<string> {
  const img = new Jimp({ width: w, height: h, color: 0xffffffff });
  return `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;
}

async function s3Admin() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: "us-east-1",
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET },
  });
}

function target(bucket: string): StoreTarget {
  return {
    store: new S3ObjectStore({
      bucket,
      region: "us-east-1",
      endpoint: S3_ENDPOINT,
      accessKeyId: S3_KEY,
      secretAccessKey: S3_SECRET,
    }),
    identity: `s3|${S3_ENDPOINT}|${bucket}`,
  };
}

async function destroyBucket(bucket: string): Promise<void> {
  const { DeleteBucketCommand, DeleteObjectCommand, ListObjectsV2Command } = await import(
    "@aws-sdk/client-s3"
  );
  const client = await s3Admin();
  const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
  for (const obj of listed.Contents ?? []) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key! }));
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

describe.skipIf(!databaseUrl || !s3Available)("M18A: MinIO end-to-end media recovery drill", () => {
  const PRIMARY = `nova-m18-primary-${RUN}`;
  const BACKUP = `nova-m18-backup-${RUN}`;
  const SCRATCH = `nova-m18-scratch-${RUN}`;
  const scratchDbName = `nova_m18_scratch_${RUN}`;
  let primary: StoreTarget;
  let backup: StoreTarget;
  let scratch: StoreTarget;
  let app: FastifyInstance;
  let scratchApp: FastifyInstance | null = null;
  let db: pg.Pool;
  let scratchDb: pg.Pool | null = null;
  let scratchUrl = "";
  let user: TestUser;
  let mediaRows: MediaKeyRow[] = [];

  beforeAll(async () => {
    const { CreateBucketCommand } = await import("@aws-sdk/client-s3");
    const client = await s3Admin();
    for (const b of [PRIMARY, BACKUP, SCRATCH]) {
      await client.send(new CreateBucketCommand({ Bucket: b }));
    }
    primary = target(PRIMARY);
    backup = target(BACKUP);
    scratch = target(SCRATCH);

    await migrate(databaseUrl!);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_STORE: "s3",
        NOVA_MEDIA_S3_BUCKET: PRIMARY,
        NOVA_MEDIA_S3_ENDPOINT: S3_ENDPOINT,
        NOVA_MEDIA_S3_ACCESS_KEY_ID: S3_KEY,
        NOVA_MEDIA_S3_SECRET_ACCESS_KEY: S3_SECRET,
      }),
      ocr: new FakeOcr(),
      objectStore: primary.store,
    });
    await app.ready();
    db = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    user = await createUser(app, `m18-recovery-${RUN}@test.local`);

    // Synthetic encrypted media in the PRIMARY bucket via the real pipeline.
    for (let i = 0; i < 2; i++) {
      const res = await user.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: {
          source_mode: "instant_capture",
          source_meta: { url: `https://m18.example.com/p${i}`, title: `M18 ${i}` },
          payload: { screenshot_data_url: await whitePng() },
          extracted_text: `m18 drill ${i}`,
          intent_text: null,
        },
      });
      expect(res.statusCode).toBe(201);
    }
    const { rows } = await db.query<MediaKeyRow & { id: string }>(
      `SELECT mm.storage_key, mm.thumb_key FROM moment_media mm
         JOIN context_moments m ON m.id = mm.moment_id WHERE m.user_id = $1`,
      [user.userId],
    );
    mediaRows = rows;
    expect(mediaRows.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  afterAll(async () => {
    await scratchApp?.close();
    await app?.close();
    await scratchDb?.end();
    if (scratchUrl) {
      const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [scratchDbName],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${scratchDbName}`);
      await admin.end();
    }
    await db?.end();
    for (const b of [PRIMARY, BACKUP, SCRATCH]) {
      await destroyBucket(b).catch(() => {});
    }
  }, 120_000);

  let inventory: Awaited<ReturnType<typeof backupMediaToStore>>["inventory"];

  it("backs up encrypted blobs into the separate backup bucket with a verifiable inventory", async () => {
    const res = await backupMediaToStore({
      rows: mediaRows,
      source: primary,
      backup,
      stamp: STAMP,
      createdAt: new Date().toISOString(),
      backupKey: BACKUP_KEY,
      apply: true,
    });
    inventory = res.inventory;
    expect(res.missingAtSource).toEqual([]);
    expect(res.copied).toBe(inventory.object_count);
    const verify = await verifyMediaBackup(inventory, backup, BACKUP_KEY);
    expect(verify).toMatchObject({ ok: true, missing: 0, altered: 0 });
  }, 60_000);

  it("wrong backup key and tampered objects fail closed against the REAL store", async () => {
    const wrong = await verifyMediaBackup(inventory, backup, randomBytes(32));
    expect(wrong.ok).toBe(false);
    expect(wrong.manifest.mac).toBe("mismatch");

    const victim = inventory.objects[0]!;
    const original = await backup.store.get(`${inventory.backup_prefix}${victim.key}`);
    await backup.store.put(`${inventory.backup_prefix}${victim.key}`, randomBytes(64));
    const tampered = await verifyMediaBackup(inventory, backup, BACKUP_KEY);
    expect(tampered.ok).toBe(false);
    expect(tampered.altered).toBe(1);
    await backup.store.put(`${inventory.backup_prefix}${victim.key}`, original!); // restore
    expect((await verifyMediaBackup(inventory, backup, BACKUP_KEY)).ok).toBe(true);
  }, 60_000);

  it("restores the database into a scratch DB and media into the scratch bucket", async () => {
    // Scratch DATABASE: schema via the real migrations + row copy of the
    // drill user's data. (The sealed pg_dump→pg_restore path is covered by
    // scripts/restore.sh + validate:recovery; this drill proves the media
    // path against real S3.)
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${scratchDbName}`);
    await admin.query(`CREATE DATABASE ${scratchDbName}`);
    await admin.end();
    const u = new URL(databaseUrl!);
    u.pathname = `/${scratchDbName}`;
    scratchUrl = u.toString();
    await migrate(scratchUrl);
    scratchDb = new pg.Pool({ connectionString: scratchUrl, max: 5 });
    for (const [table, where, params] of [
      ["users", "id = $1", [user.userId]],
      ["context_moments", "user_id = $1", [user.userId]],
      ["moment_media", "moment_id IN (SELECT id FROM context_moments WHERE user_id = $1)", [user.userId]],
    ] as const) {
      const { rows } = await db.query(`SELECT * FROM ${table} WHERE ${where}`, [...params]);
      for (const row of rows) {
        const cols = Object.keys(row);
        await scratchDb.query(
          `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
          cols.map((c) => row[c]),
        );
      }
    }

    // Media restore: backup bucket → SCRATCH bucket at the original keys.
    const restored = await restoreMediaFromBackup({
      inv: inventory,
      backup,
      destination: scratch,
      apply: true,
    });
    expect(restored.failedVerify).toBe(0);
    expect(restored.restored).toBe(inventory.object_count);
    // Restoring into the PRIMARY is refused (drill isolation).
    await expect(
      restoreMediaFromBackup({ inv: inventory, backup, destination: primary, apply: false }),
    ).rejects.toThrow(/ORIGINAL primary/);
  }, 120_000);

  it("media:verify over the scratch stack: every DB-referenced blob present AND decryptable", async () => {
    const keys = [parseEncryptionKey(KEY_HEX)];
    const { rows } = await scratchDb!.query<{ storage_key: string; thumb_key: string | null }>(
      `SELECT storage_key, thumb_key FROM moment_media`,
    );
    expect(rows.length).toBe(mediaRows.length);
    for (const row of rows) {
      for (const key of [row.storage_key, ...(row.thumb_key ? [row.thumb_key] : [])]) {
        const blob = await scratch.store.get(key);
        expect(blob, `missing restored blob for a referenced key`).not.toBeNull();
        expect(() => decryptBytesWithAny(keys, blob!)).not.toThrow();
      }
    }
  }, 60_000);

  it("MANDATORY post-restore synthetic smoke: the real runSmoke walk passes against the scratch stack", async () => {
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
      objectStore: scratch.store,
    });
    await scratchApp.listen({ port: 0, host: "127.0.0.1" });
    const address = scratchApp.server.address() as { port: number };
    const { ok, steps } = await runSmoke(`http://127.0.0.1:${address.port}`, {});
    const failed = steps.filter((s) => s.status === "fail").map((s) => s.step);
    expect(failed, `failed smoke steps: ${failed.join(", ")}`).toEqual([]);
    expect(ok).toBe(true);
  }, 120_000);

  it("primary and scratch stay separate: the drill wrote nothing into the primary bucket", async () => {
    const primaryKeys = (await primary.store.list()).map((o) => o.key).sort();
    // Exactly the original referenced objects — nothing added, nothing removed.
    const expected = [...new Set(mediaRows.flatMap((r) => [r.storage_key, ...(r.thumb_key ? [r.thumb_key] : [])]))].sort();
    expect(primaryKeys).toEqual(expected);
    expect(scratch.identity).not.toBe(primary.identity);
    expect(backup.identity).not.toBe(primary.identity);
  }, 60_000);

  it("evidence retention works against the real store (private prefix, hash-verifiable)", async () => {
    // The gate's retention path is unit-tested in tools/validation-gate; here
    // we prove the identical put/get semantics hold on a REAL S3 API.
    const body = Buffer.from(JSON.stringify({ outcome: "PASS", run: RUN }));
    const key = `validation-evidence/test/${RUN}/report.json`;
    await backup.store.put(key, body);
    const readBack = await backup.store.get(key);
    expect(readBack).toEqual(body);
  }, 60_000);
});
