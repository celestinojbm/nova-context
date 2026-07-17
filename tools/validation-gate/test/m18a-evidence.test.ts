import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evidencePrefix,
  retainEvidence,
  verifyEvidenceMeta,
  type EvidenceMeta,
  type EvidencePutStore,
} from "../src/evidence.js";

/** M18A.1 finding 6: evidence retention — sanitized errors, HMAC-authenticated
 * meta.json (commit marker), never-silently-retained on failure. */

class MemEvidenceStore implements EvidencePutStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, data: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(data));
  }
}

const BACKUP_KEY = randomBytes(32);
const UPLOADED_AT = "2026-07-17T00:00:00.000Z";

function writeReports(): Array<{ path: string }> {
  const dir = mkdtempSync(join(tmpdir(), "nova-evidence-"));
  const files = [];
  for (const [name, content] of [
    ["report.json", '{"outcome":"PASS","checks":[]}'],
    ["report.md", "# report\nPASS"],
    ["junit.xml", "<testsuite/>"],
  ] as const) {
    const p = join(dir, name);
    writeFileSync(p, content);
    files.push({ path: p });
  }
  return files;
}

describe("M18A.1 finding 6: validation evidence retention", () => {
  it("uploads reports then meta.json LAST with correct sha256es + HMAC", async () => {
    const store = new MemEvidenceStore();
    const res = await retainEvidence({
      store,
      mode: "postdeploy",
      runId: "run-1",
      outcome: "PASS",
      gitSha: "abc1234",
      uploadedAt: UPLOADED_AT,
      files: writeReports(),
      backupKey: BACKUP_KEY,
    });
    expect(res.ok).toBe(true);
    expect(res.authenticated).toBe(true);
    // meta.json is the last uploaded item (the commit marker).
    expect(res.uploaded[res.uploaded.length - 1]).toBe("meta.json");
    const prefix = evidencePrefix("postdeploy", "run-1");
    for (const name of ["report.json", "report.md", "junit.xml"]) {
      const buf = store.objects.get(`${prefix}${name}`)!;
      expect(createHash("sha256").update(buf).digest("hex")).toBe(res.hashes[name]);
    }
    const meta = JSON.parse(store.objects.get(`${prefix}meta.json`)!.toString()) as EvidenceMeta;
    expect(meta).toMatchObject({ run_id: "run-1", mode: "postdeploy", outcome: "PASS", authenticated: true });
    // HMAC verifies with the right key and fails with the wrong key.
    expect(verifyEvidenceMeta(meta, BACKUP_KEY)).toBe(true);
    expect(verifyEvidenceMeta(meta, randomBytes(32))).toBe(false);
  });

  it("tampered meta (any field) fails HMAC verification", async () => {
    const store = new MemEvidenceStore();
    const res = await retainEvidence({
      store,
      mode: "recovery",
      runId: "run-2",
      outcome: "PASS",
      gitSha: "abc1234",
      uploadedAt: UPLOADED_AT,
      files: writeReports(),
      backupKey: BACKUP_KEY,
    });
    const meta = JSON.parse(store.objects.get(`${res.prefix}meta.json`)!.toString()) as EvidenceMeta;
    expect(verifyEvidenceMeta({ ...meta, outcome: "FAIL" }, BACKUP_KEY)).toBe(false);
    expect(verifyEvidenceMeta({ ...meta, files: { ...meta.files, extra: "x".repeat(64) } }, BACKUP_KEY)).toBe(false);
  });

  it("without NOVA_BACKUP_KEY, meta is honestly marked authenticated:false (integrity-only)", async () => {
    const store = new MemEvidenceStore();
    const res = await retainEvidence({
      store,
      mode: "pr",
      runId: "run-3",
      outcome: "PASS",
      gitSha: "abc1234",
      uploadedAt: UPLOADED_AT,
      files: writeReports(),
    });
    expect(res.authenticated).toBe(false);
    const meta = JSON.parse(store.objects.get(`${res.prefix}meta.json`)!.toString()) as EvidenceMeta;
    expect(meta.authenticated).toBe(false);
    expect(meta.mac).toBe("");
    expect(verifyEvidenceMeta(meta, BACKUP_KEY)).toBe(false); // unauthenticated → not trusted
  });

  it("upload failure returns ok:false; the SANITIZED error hides all injected secrets", async () => {
    const token = "tok-live-session-abcdef123456";
    const password = "Vg1-secretpassword-xyz";
    const invite = "syn-invite-topsecret";
    const accessKey = "AKIAEVIDENCEKEY12345";
    const secretKey = "s3-evidence-secret-key-value-zzz";
    const endpoint = "https://evidence.example.internal:9000";
    const bucket = "nova-private-evidence";
    // A store whose error message embeds every sensitive value.
    const store: EvidencePutStore = {
      async put() {
        throw new Error(
          `PutObject to ${endpoint}/${bucket} failed for key with creds ${accessKey}:${secretKey} ` +
            `token=${token} password=${password} invite=${invite} data:image/png;base64,AAAA`,
        );
      },
    };
    const res = await retainEvidence({
      store,
      mode: "postdeploy",
      runId: "run-4",
      outcome: "FAIL",
      gitSha: "abc1234",
      uploadedAt: UPLOADED_AT,
      files: writeReports(),
      extraSecrets: [token, password, invite],
      env: {
        NOVA_VALIDATE_EVIDENCE_S3_ACCESS_KEY_ID: accessKey,
        NOVA_VALIDATE_EVIDENCE_S3_SECRET_ACCESS_KEY: secretKey,
      } as NodeJS.ProcessEnv,
    });
    expect(res.ok).toBe(false);
    const out = res.error ?? "";
    for (const secret of [token, password, invite, accessKey, secretKey]) {
      expect(out).not.toContain(secret);
    }
    expect(out).not.toContain("data:image/png;base64,AAAA");
    expect(res.uploaded).not.toContain("meta.json"); // no commit marker on failure
  });
});
