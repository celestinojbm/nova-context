import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { computeExit } from "../src/recovery-remote.js";

/**
 * M18A.4 P1-1 (NCA-17-001): `validate:recovery-remote` must NEVER exit 0 on a
 * recovery failure. Two layers:
 *   1. `computeExit` — the pure terminal-exit rule, tested exhaustively so the
 *      exact mapping (success→0, FAIL/BLOCKED/fetch-failure→non-zero, cleanup
 *      failure→non-zero even when the gate passed) is pinned;
 *   2. the REAL operator entrypoint spawned as a child process, asserting that
 *      fetch failures / throws / a forced cleanup failure all exit non-zero,
 *      never print PASS, and never leak a secret. The success→0 and gate
 *      FAIL/BLOCKED real-CLI paths are exercised by the M18A.3 recovery E2E
 *      (real Postgres + MinIO), which this file complements.
 */
const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "..", "..", "..");

const S3_ENDPOINT = process.env.NOVA_TEST_S3_ENDPOINT ?? "http://127.0.0.1:9000";
const S3_KEY = process.env.NOVA_TEST_S3_ACCESS_KEY_ID ?? "nova";
const S3_SECRET = process.env.NOVA_TEST_S3_SECRET_ACCESS_KEY ?? "nova-minio-secret";

const SECRET_PW = "supersecretdbpw-zzz";

/** Run the REAL operator entrypoint and capture exit code + combined output. */
async function runRemote(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "pnpm",
      ["--filter", "@nova/validation-gate", "--silent", "recovery-remote", "--", ...args],
      { cwd: repoRoot, env: { ...process.env, ...env }, timeout: 120_000 },
    );
    return { code: 0, out: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

/** Env that lets the fetch child's loadEnv() succeed (media store = s3). */
const fetchEnv = (over: Record<string, string> = {}): Record<string, string> => ({
  DATABASE_URL: `postgresql://nova:${SECRET_PW}@127.0.0.1:5432/nova_scratch`,
  NOVA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  NOVA_MEDIA_STORE: "s3",
  NOVA_MEDIA_S3_BUCKET: "scratch-bucket",
  NOVA_MEDIA_S3_ENDPOINT: S3_ENDPOINT,
  NOVA_MEDIA_S3_ACCESS_KEY_ID: S3_KEY,
  NOVA_MEDIA_S3_SECRET_ACCESS_KEY: S3_SECRET,
  NOVA_BACKUP_S3_BUCKET: "backup-bucket",
  NOVA_BACKUP_S3_ENDPOINT: S3_ENDPOINT,
  NOVA_BACKUP_S3_ACCESS_KEY_ID: S3_KEY,
  NOVA_BACKUP_S3_SECRET_ACCESS_KEY: S3_SECRET,
  ...over,
});

describe("computeExit (NCA-17-001 terminal-exit rule)", () => {
  it("exits 0 ONLY on gate success + successful cleanup", () => {
    expect(computeExit(0, true)).toBe(0); // 1. success → 0
  });
  it("gate FAIL/BLOCKED (non-zero) stays non-zero", () => {
    expect(computeExit(2, true)).toBe(2); // 5. gate FAIL
    expect(computeExit(3, true)).toBe(3); // 6. gate BLOCKED
    expect(computeExit(1, true)).toBe(1);
  });
  it("cleanup failure forces non-zero EVEN when the gate passed", () => {
    expect(computeExit(0, false)).toBe(1); // 7. cleanup failure → non-zero
  });
  it("both a non-zero gate and a failed cleanup stay non-zero", () => {
    expect(computeExit(2, false)).toBe(2);
    expect(computeExit(5, false)).toBe(5);
  });
});

describe("validate:recovery-remote — real CLI exit codes (NCA-17-001)", () => {
  it("missing required args → exit 2 (usage)", async () => {
    const { code, out } = await runRemote([], fetchEnv());
    expect(code).toBe(2);
    expect(out).not.toContain("PASS");
  }, 60_000);

  it("fetch throws (malformed NOVA_BACKUP_KEY) → non-zero, cleanup ran, no PASS, no secret", async () => {
    const { code, out } = await runRemote(
      ["--stamp=20260101T000000Z", "--restored-base-url=http://127.0.0.1:65535"],
      fetchEnv({ NOVA_BACKUP_KEY: "not-a-valid-hex-key" }),
    );
    expect(code).not.toBe(0); // the core bug: this must NOT be 0
    expect(out).toContain("remote_fetch FAILED");
    // Cleanup ALWAYS runs — the workspace is removed even on a fetch failure.
    expect(out).toContain("remote_workspace_cleanup: temporary recovery workspace removed");
    expect(out).not.toContain("PASS");
    expect(out).not.toContain(SECRET_PW); // no DSN credential leaks to stdout/stderr
  }, 120_000);

  it("forced cleanup failure → non-zero + explicit cleanup-FAILED evidence", async () => {
    const { code, out } = await runRemote(
      ["--stamp=20260101T000000Z", "--restored-base-url=http://127.0.0.1:65535"],
      fetchEnv({ NOVA_BACKUP_KEY: "not-a-valid-hex-key", NOVA_RECOVERY_REMOTE_FORCE_CLEANUP_FAILURE: "1" }),
    );
    expect(code).not.toBe(0);
    expect(out).toContain("remote_workspace_cleanup FAILED");
    expect(out).not.toContain(SECRET_PW);
  }, 120_000);
  // The `marker missing → non-zero`, real `success → 0`, and gate-BLOCKED
  // real-CLI paths are exercised in services/api's M18A.3 recovery E2E, which
  // has the S3 SDK + a real committed sealed set + a booted restored stack.
});
