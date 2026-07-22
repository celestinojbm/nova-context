import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../src/media/object-store.js";
import { decryptFile, encryptFile, parseBackupKey } from "../../src/backup/crypto.js";
import { buildManifest, writeManifest } from "../../src/backup/manifest.js";
import {
  fetchSealedBackup,
  publishSealedBackup,
  remotePrefixFor,
  verifySealedBackupRemote,
} from "../../src/backup/sealed-backup-s3.js";

/**
 * M18A.2 §3 — sealed backup publish/fetch against a REAL S3 API (MinIO locally;
 * the identical client/path R2 uses). Proves a committed set round-trips
 * (publish → verify → fetch → backup:verify), that NO plaintext is uploaded,
 * that the fetch CLI's private temp dir is removed at exit, and that the remote
 * fetch refuses an uncommitted set. Synthetic data only; no external resources.
 */
const execFileAsync = promisify(execFile);
const databaseUrl = process.env.DATABASE_URL;
const S3_ENDPOINT = process.env.NOVA_TEST_S3_ENDPOINT ?? "http://127.0.0.1:9000";
const S3_KEY = process.env.NOVA_TEST_S3_ACCESS_KEY_ID ?? "nova";
const S3_SECRET = process.env.NOVA_TEST_S3_SECRET_ACCESS_KEY ?? "nova-minio-secret";
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

const s3Required = process.env.NOVA_TEST_S3_REQUIRED === "yes";
const s3Available = await (async () => {
  try {
    return (await fetch(`${S3_ENDPOINT}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
})();

if (s3Required && !s3Available) {
  describe("M18A.2 §3: sealed backup publish/fetch (REQUIRED)", () => {
    it("MinIO must be available when NOVA_TEST_S3_REQUIRED=yes", () => {
      throw new Error(`NOVA_TEST_S3_REQUIRED=yes but MinIO(${S3_ENDPOINT}) is unavailable`);
    });
  });
}

const RUN = randomBytes(4).toString("hex");
const KEY = parseBackupKey(randomBytes(32).toString("hex"));
const STAMP = `20260717T${RUN}Z`;
const dirs: string[] = [];

function backupStore(bucket: string) {
  return new S3ObjectStore({ bucket, region: "us-east-1", endpoint: S3_ENDPOINT, accessKeyId: S3_KEY, secretAccessKey: S3_SECRET });
}
async function s3Admin() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({ region: "us-east-1", endpoint: S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET } });
}

async function makeSealedBackup(dbSecret: Buffer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "nova-sealed-"));
  dirs.push(dir);
  const dbPlain = join(dir, `nova-db-${STAMP}.dump`);
  writeFileSync(dbPlain, dbSecret);
  await encryptFile(dbPlain, `${dbPlain}.enc`, KEY);
  rmSync(dbPlain);
  const manifest = await buildManifest(dir, STAMP, "2026-07-17T00:00:00Z", [{ name: `nova-db-${STAMP}.dump.enc`, role: "postgres" }], KEY);
  await writeManifest(dir, manifest);
  return dir;
}

describe.skipIf(!s3Available)("M18A.2 §3: sealed backup publish/fetch against real MinIO", () => {
  const BUCKET = `nova-m18a2-sealed-${RUN}`;

  afterAll(async () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    try {
      const { DeleteBucketCommand, DeleteObjectCommand, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const client = await s3Admin();
      const listed = await client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
      for (const o of listed.Contents ?? []) await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.Key! }));
      await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    } catch {
      /* best-effort */
    }
  });

  it("publish → verify → fetch → backup:verify round-trips; NO plaintext uploaded", async () => {
    const { CreateBucketCommand } = await import("@aws-sdk/client-s3");
    await (await s3Admin()).send(new CreateBucketCommand({ Bucket: BUCKET }));
    const secret = Buffer.from(`PLAINTEXT-DB-SECRET-${RUN}`.padEnd(4096, "x"));
    const dir = await makeSealedBackup(secret);
    const store = backupStore(BUCKET);

    const pub = await publishSealedBackup({ dir, stamp: STAMP, store, backupKey: KEY, createdAt: "2026-07-17T00:00:00Z", apply: true });
    expect(pub.applied).toBe(true);
    expect(pub.verifiedAtDestination).toBe(pub.expected);

    // No plaintext in the remote store: the sealed db object must NOT contain
    // the plaintext secret, and it must decrypt back to it with the key.
    const prefix = remotePrefixFor(STAMP);
    const stored = await store.get(`${prefix}nova-db-${STAMP}.dump.enc`);
    expect(stored).not.toBeNull();
    expect(stored!.includes(Buffer.from(`PLAINTEXT-DB-SECRET-${RUN}`))).toBe(false);

    const verify = await verifySealedBackupRemote({ store, stamp: STAMP, backupKey: KEY });
    expect(verify.ok).toBe(true);
    expect(verify.marker.mac).toBe("ok");

    const out = mkdtempSync(join(tmpdir(), "nova-fetch-out-"));
    dirs.push(out);
    const fetched = await fetchSealedBackup({ store, stamp: STAMP, backupKey: KEY, destDir: out });
    expect(fetched.ok).toBe(true);
    // The fetched sealed db decrypts to the original plaintext.
    const back = join(out, `nova-db-plain-${RUN}`);
    await decryptFile(join(out, `nova-db-${STAMP}.dump.enc`), back, KEY);
    expect(readFileSync(back).equals(secret)).toBe(true);
  }, 120_000);

  it("the fetch CLI's private temp dir is removed at exit (no --out)", async () => {
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("nova-fetch-")));
    const { stdout } = await execFileAsync(
      "pnpm",
      ["--filter", "@nova/api", "--silent", "backup:fetch-s3", "--", `--stamp=${STAMP}`],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl ?? "postgres://nova:nova@localhost:5432/nova",
          NOVA_BACKUP_KEY: KEY.toString("hex"),
          NOVA_BACKUP_S3_BUCKET: BUCKET,
          NOVA_BACKUP_S3_ENDPOINT: S3_ENDPOINT,
          NOVA_BACKUP_S3_ACCESS_KEY_ID: S3_KEY,
          NOVA_BACKUP_S3_SECRET_ACCESS_KEY: S3_SECRET,
        },
      },
    );
    expect(stdout).toContain("SEALED BACKUP FETCH OK");
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("nova-fetch-") && !before.has(n));
    // No new nova-fetch-* temp dir left behind by the CLI.
    for (const leftover of after) expect(existsSync(join(tmpdir(), leftover))).toBe(false);
  }, 120_000);

  it("fetch refuses an uncommitted set (marker deleted → not committed)", async () => {
    const store = backupStore(BUCKET);
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await s3Admin()).send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `${remotePrefixFor(STAMP)}remote-marker.json` }));
    const out = mkdtempSync(join(tmpdir(), "nova-fetch-out-"));
    dirs.push(out);
    await expect(fetchSealedBackup({ store, stamp: STAMP, backupKey: KEY, destDir: out })).rejects.toThrow(/not a committed/);
  }, 60_000);
});
