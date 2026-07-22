import { describe, expect, it } from "vitest";
import { sanitizeBackupError } from "./sanitize.js";

/**
 * M18A.3 §5: the backup S3 CLIs must never leak provider secrets/identifiers in
 * error text. Inject an error containing every sensitive value and prove none
 * survives sanitization.
 */
describe("sanitizeBackupError (M18A.3 §5)", () => {
  const env = {
    NOVA_BACKUP_KEY: "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344",
    NOVA_ENCRYPTION_KEY: "ffee0011ffee0011ffee0011ffee0011ffee0011ffee0011ffee0011ffee0011",
    DATABASE_URL: "postgresql://novauser:supersecretdbpw@render-pg.internal:5432/nova",
    NOVA_BACKUP_S3_ACCESS_KEY_ID: "AKIABACKUPKEYID12345",
    NOVA_BACKUP_S3_SECRET_ACCESS_KEY: "backup-secret-access-key-value-xyz",
    NOVA_BACKUP_S3_ENDPOINT: "https://minio.internal:9000",
    NOVA_BACKUP_S3_BUCKET: "nova-private-backup",
    NOVA_MEDIA_S3_BUCKET: "logs", // short (3-5 char) bucket name
  } as NodeJS.ProcessEnv;

  it("redacts every provider secret/identifier + resolved private IP + DSN creds", () => {
    const raw =
      `PutObject to https://minio.internal:9000/nova-private-backup failed for key ` +
      `media/x with creds ${env.NOVA_BACKUP_S3_ACCESS_KEY_ID}:${env.NOVA_BACKUP_S3_SECRET_ACCESS_KEY}; ` +
      `getaddrinfo ENOTFOUND minio.internal; connect ECONNREFUSED 10.4.5.6:9000; ` +
      `dsn ${env.DATABASE_URL}; backupKey ${env.NOVA_BACKUP_KEY}; bucket logs`;
    const out = sanitizeBackupError(raw, env);
    for (const secret of [
      "minio.internal",
      "nova-private-backup",
      env.NOVA_BACKUP_S3_ACCESS_KEY_ID,
      env.NOVA_BACKUP_S3_SECRET_ACCESS_KEY,
      env.NOVA_BACKUP_KEY,
      "supersecretdbpw",
      "novauser",
      "10.4.5.6",
    ]) {
      expect(out).not.toContain(secret as string);
    }
    // The short media bucket "logs" is a declared identifier → redacted.
    expect(out).not.toMatch(/bucket logs\b/);
    expect(out).toContain("[REDACTED]");
  });

  it("leaves non-secret text intact and never throws on empty/plain input", () => {
    expect(sanitizeBackupError("", env)).toBe("");
    const out = sanitizeBackupError("remote sealed backup 20260101T000000Z is not a committed set", env);
    expect(out).toContain("not a committed set"); // stamp/status kept
  });
});
