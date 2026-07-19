import { describe, expect, it } from "vitest";
import {
  REMOTE_SCRATCH_CONFIRM,
  canonicalizeDbIdentity,
  classifyRestoreTarget,
  classifyScratchTarget,
  dbTargetFingerprint,
  redactDatabaseUrl,
} from "./target.js";

/**
 * M15B (Hermes D03): restore never prints raw credentials, and only a
 * loopback non-production target is "local scratch"; everything else — a
 * remote nova_alpha included — requires the production override.
 */
describe("redactDatabaseUrl", () => {
  it("removes username and password", () => {
    const r = redactDatabaseUrl("postgres://nova:s3cr3t@db.prod.internal:5432/nova_alpha");
    expect(r).not.toContain("nova:");
    expect(r).not.toContain("s3cr3t");
    expect(r).toBe("postgres://***@db.prod.internal:5432/nova_alpha");
  });
  it("handles a credential-less URL and unparseable input", () => {
    expect(redactDatabaseUrl("postgres://localhost:5432/nova")).toBe(
      "postgres://localhost:5432/nova",
    );
    expect(redactDatabaseUrl("not a url")).toBe("<unparseable-database-url>");
  });
});

describe("classifyRestoreTarget", () => {
  it("local loopback scratch → no override needed", () => {
    const t = classifyRestoreTarget("postgres://nova:nova@localhost:5432/nova_restore");
    expect(t.local).toBe(true);
    expect(t.requiresOverride).toBe(false);
    expect(t.redacted).not.toContain("nova:nova");
  });

  it("remote nova_alpha → requires override (the old allowlist bug)", () => {
    const t = classifyRestoreTarget("postgres://u:p@db.example.com:5432/nova_alpha");
    expect(t.local).toBe(false);
    expect(t.requiresOverride).toBe(true);
    expect(t.redacted).toBe("postgres://***@db.example.com:5432/nova_alpha");
  });

  it("production env on loopback → still requires override", () => {
    const t = classifyRestoreTarget("postgres://nova@127.0.0.1:5432/nova", "production");
    expect(t.requiresOverride).toBe(true);
  });

  it("any remote host → requires override", () => {
    expect(classifyRestoreTarget("postgres://x@10.0.0.5/db").requiresOverride).toBe(true);
    expect(classifyRestoreTarget("postgres://x@some-host/db").requiresOverride).toBe(true);
  });
});

/**
 * M18A.2: DB target fingerprint (credential-free) + explicitly-authorized
 * remote scratch classification for the recovery gate.
 */
describe("dbTargetFingerprint / canonicalizeDbIdentity", () => {
  it("is credential-free and stable across username/password/casing/port-default", () => {
    const a = "postgresql://u1:p1@Render-PG.internal:5432/nova_scratch";
    const b = "postgresql://u2:different@render-pg.internal/nova_scratch"; // no port → default 5432
    expect(dbTargetFingerprint(a)).toBe(dbTargetFingerprint(b));
    expect(canonicalizeDbIdentity(a)).not.toMatch(/u1|p1|different/);
  });
  it("distinguishes database name, host, and TLS posture", () => {
    const base = "postgresql://u:p@h:5432/dbA";
    expect(dbTargetFingerprint(base)).not.toBe(dbTargetFingerprint("postgresql://u:p@h:5432/dbB"));
    expect(dbTargetFingerprint(base)).not.toBe(dbTargetFingerprint("postgresql://u:p@other:5432/dbA"));
    expect(dbTargetFingerprint(base)).not.toBe(
      dbTargetFingerprint("postgresql://u:p@h:5432/dbA?sslmode=require"),
    );
  });
  it("treats postgres:// and postgresql:// as the same protocol", () => {
    expect(dbTargetFingerprint("postgres://u:p@h/db")).toBe(dbTargetFingerprint("postgresql://u:p@h/db"));
  });
});

describe("classifyScratchTarget (M18A.2)", () => {
  const REMOTE_DSN = "postgresql://u:p@render-pg.internal:5432/nova_scratch_run42?sslmode=require";
  const REMOTE_FP = dbTargetFingerprint(REMOTE_DSN);
  const PRIMARY_FP = dbTargetFingerprint("postgresql://u:p@prod-pg.internal:5432/nova?sslmode=require");

  /** A fully-authorized remote scratch env; individual tests break one field. */
  const authEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
    ({
      NODE_ENV: "test",
      NOVA_VALIDATE_ALLOW_REMOTE_SCRATCH: "yes",
      NOVA_RESTORE_TARGET_CLASS: "scratch",
      NOVA_RESTORE_SCRATCH_CONFIRM: REMOTE_SCRATCH_CONFIRM,
      NOVA_RESTORE_EXPECT_HOST: "render-pg.internal",
      NOVA_RESTORE_EXPECT_DATABASE: "nova_scratch_run42",
      NOVA_RESTORE_EXPECT_FINGERPRINT: REMOTE_FP,
      NOVA_PRIMARY_DATABASE_FINGERPRINT: PRIMARY_FP,
      NOVA_RECOVERY_RUN_ID: "run42",
      ...over,
    }) as NodeJS.ProcessEnv;

  it("local loopback non-production → local_scratch", () => {
    const c = classifyScratchTarget("postgresql://nova:nova@localhost:5432/scratch", { NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(c.verdict).toBe("local_scratch");
  });

  it("remote target WITHOUT authorization → blocked", () => {
    const c = classifyScratchTarget(REMOTE_DSN, { NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(c.verdict).toBe("blocked");
    expect(c.reasons.join(" ")).toContain("NOVA_VALIDATE_ALLOW_REMOTE_SCRATCH");
  });

  it("fully authorized remote scratch → remote_scratch", () => {
    const c = classifyScratchTarget(REMOTE_DSN, authEnv());
    expect(c.verdict).toBe("remote_scratch");
    expect(c.reasons).toEqual([]);
  });

  it("host mismatch → blocked", () => {
    const c = classifyScratchTarget(REMOTE_DSN, authEnv({ NOVA_RESTORE_EXPECT_HOST: "other.internal" }));
    expect(c.verdict).toBe("blocked");
    expect(c.reasons.join(" ")).toContain("host differs");
  });

  it("database mismatch → blocked", () => {
    const c = classifyScratchTarget(REMOTE_DSN, authEnv({ NOVA_RESTORE_EXPECT_DATABASE: "nova_scratch_other" }));
    expect(c.verdict).toBe("blocked");
    expect(c.reasons.join(" ")).toContain("database differs");
  });

  it("missing run-id marker → blocked", () => {
    const c = classifyScratchTarget(REMOTE_DSN, authEnv({ NOVA_RECOVERY_RUN_ID: "run99" }));
    expect(c.verdict).toBe("blocked");
    expect(c.reasons.join(" ")).toContain("NOVA_RECOVERY_RUN_ID");
  });

  it("scratch fingerprint EQUALS primary fingerprint → blocked", () => {
    const c = classifyScratchTarget(REMOTE_DSN, authEnv({ NOVA_PRIMARY_DATABASE_FINGERPRINT: REMOTE_FP }));
    expect(c.verdict).toBe("blocked");
    expect(c.reasons.join(" ")).toContain("EQUALS the primary");
  });

  it("expected fingerprint mismatch → blocked", () => {
    const c = classifyScratchTarget(REMOTE_DSN, authEnv({ NOVA_RESTORE_EXPECT_FINGERPRINT: "a".repeat(64) }));
    expect(c.verdict).toBe("blocked");
    expect(c.reasons.join(" ")).toContain("fingerprint differs");
  });

  it("malformed expected fingerprint → blocked (not proceed)", () => {
    const c = classifyScratchTarget(REMOTE_DSN, authEnv({ NOVA_RESTORE_EXPECT_FINGERPRINT: "not-hex" }));
    expect(c.verdict).toBe("blocked");
    expect(c.reasons.join(" ")).toContain("NOVA_RESTORE_EXPECT_FINGERPRINT");
  });

  it("NODE_ENV=production does NOT block an otherwise-authorized remote scratch (M18A.3 §1)", () => {
    // A recovery job may run production-runtime; safety is the envelope, not
    // NODE_ENV. The managed scratch DB is still proven scratch by host/db/
    // fingerprint/run-id/primary-diff/confirmation.
    const c = classifyScratchTarget(REMOTE_DSN, authEnv({ NODE_ENV: "production" }));
    expect(c.verdict).toBe("remote_scratch");
    expect(c.reasons).toEqual([]);
  });

  it("local loopback STILL requires non-production (branch A unchanged)", () => {
    const c = classifyScratchTarget("postgresql://nova:nova@localhost:5432/scratch", {
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);
    // loopback+production falls through to the remote branch → blocked without
    // the full envelope.
    expect(c.verdict).toBe("blocked");
  });

  it("malformed DATABASE_URL → error (FAIL, not block)", () => {
    const c = classifyScratchTarget("not a url", authEnv());
    expect(c.verdict).toBe("error");
  });

  it("never leaks credentials in the redacted target or reasons", () => {
    const c = classifyScratchTarget(REMOTE_DSN, authEnv({ NOVA_RESTORE_EXPECT_HOST: "wrong" }));
    const blob = `${c.redacted} ${c.reasons.join(" ")}`;
    expect(blob).not.toContain(":p@");
    expect(blob).not.toContain("u:p");
    expect(c.redacted).toBe("postgresql://***@render-pg.internal:5432/nova_scratch_run42");
  });
});
