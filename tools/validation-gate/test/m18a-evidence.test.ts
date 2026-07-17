import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evidencePrefix, retainEvidence, type EvidencePutStore } from "../src/evidence.js";

/** M18A §4 — evidence retention: hashes recorded, uploads land under the
 * private prefix, failure is explicit (never a silent claim of retention). */

class MemEvidenceStore implements EvidencePutStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, data: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(data));
  }
}

class BrokenStore implements EvidencePutStore {
  async put(): Promise<void> {
    throw new Error("simulated evidence store outage");
  }
}

function writeReports(): { dir: string; files: Array<{ path: string }> } {
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
  return { dir, files };
}

describe("M18A §4: validation evidence retention", () => {
  it("uploads reports + meta.json under validation-evidence/<mode>/<run-id>/ with correct sha256es", async () => {
    const store = new MemEvidenceStore();
    const { files } = writeReports();
    const res = await retainEvidence({
      store,
      mode: "postdeploy",
      runId: "run-1",
      outcome: "PASS",
      gitSha: "abc1234",
      files,
    });
    expect(res.ok).toBe(true);
    const prefix = evidencePrefix("postdeploy", "run-1");
    expect(res.prefix).toBe(prefix);
    expect(res.uploaded.sort()).toEqual(["junit.xml", "meta.json", "report.json", "report.md"]);
    // Hashes match the uploaded bytes exactly (tamper-evident evidence).
    for (const name of ["report.json", "report.md", "junit.xml"]) {
      const buf = store.objects.get(`${prefix}${name}`)!;
      expect(createHash("sha256").update(buf).digest("hex")).toBe(res.hashes[name]);
    }
    const meta = JSON.parse(store.objects.get(`${prefix}meta.json`)!.toString());
    expect(meta).toMatchObject({ run_id: "run-1", mode: "postdeploy", outcome: "PASS", git_sha: "abc1234" });
    expect(meta.files["report.json"]).toBe(res.hashes["report.json"]);
  });

  it("upload failure returns ok:false with the error — retention is never silently claimed", async () => {
    const { files } = writeReports();
    const res = await retainEvidence({
      store: new BrokenStore(),
      mode: "recovery",
      runId: "run-2",
      outcome: "FAIL",
      gitSha: "abc1234",
      files,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("simulated evidence store outage");
    expect(res.uploaded).toHaveLength(0);
  });

  it("meta.json carries no environment values (names/hashes/ids only)", async () => {
    const store = new MemEvidenceStore();
    const { files } = writeReports();
    process.env.NOVA_TEST_FAKE_SECRET_M18A = "super-secret-value-m18a";
    try {
      const res = await retainEvidence({
        store,
        mode: "pr",
        runId: "run-3",
        outcome: "PASS",
        gitSha: "abc1234",
        files,
      });
      const meta = store.objects.get(`${res.prefix}meta.json`)!.toString();
      expect(meta).not.toContain("super-secret-value-m18a");
      expect(Object.keys(JSON.parse(meta)).sort()).toEqual([
        "files",
        "git_sha",
        "mode",
        "outcome",
        "run_id",
        "uploaded_at",
      ]);
    } finally {
      delete process.env.NOVA_TEST_FAKE_SECRET_M18A;
    }
  });
});
