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
  // P1-3 (NCA-17-003): a strong 32-hex run id, delimiter-bound to the db name.
  const RUN_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const REMOTE_DSN = `postgresql://u:p@render-pg.internal:5432/nova_scratch_${RUN_ID}?sslmode=require`;
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
      NOVA_RESTORE_EXPECT_DATABASE: `nova_scratch_${RUN_ID}`,
      NOVA_RESTORE_EXPECT_FINGERPRINT: REMOTE_FP,
      NOVA_PRIMARY_DATABASE_FINGERPRINT: PRIMARY_FP,
      NOVA_RECOVERY_RUN_ID: RUN_ID,
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

  it("run-id not bound to the db name (different strong id) → blocked", () => {
    const c = classifyScratchTarget(REMOTE_DSN, authEnv({ NOVA_RECOVERY_RUN_ID: "0".repeat(32) }));
    expect(c.verdict).toBe("blocked");
    expect(c.reasons.join(" ")).toContain("NOVA_RECOVERY_RUN_ID");
  });

  it("last-64-chars database mismatch: expected db must also match exactly", () => {
    const c = classifyScratchTarget(REMOTE_DSN, authEnv({ NOVA_RESTORE_EXPECT_DATABASE: `nova_other_${RUN_ID}` }));
    expect(c.verdict).toBe("blocked");
    expect(c.reasons.join(" ")).toContain("database differs");
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
    expect(c.redacted).toBe(`postgresql://***@render-pg.internal:5432/nova_scratch_${RUN_ID}`);
  });
});

/**
 * M18A.4 P1-3 (NCA-17-003): host identity canonicalization + a strict,
 * delimiter-bound recovery run-id contract. Fingerprinting is DEFENCE IN DEPTH,
 * not a replacement for provider IAM — recovery credentials must remain
 * incapable of writing the primary database. These tests pin the identity
 * collapses and the run-id contract so an equivalent DSN can never split
 * identity and a weak run id can never authorize a restore.
 */
describe("canonicalizeDbIdentity — host identity collapses (P1-3)", () => {
  it("1. trailing-dot FQDN ≡ no trailing dot", () => {
    expect(dbTargetFingerprint("postgresql://u:p@db.internal./nova")).toBe(
      dbTargetFingerprint("postgresql://u:p@db.internal/nova"),
    );
  });
  it("2. uppercase host ≡ lowercase host", () => {
    expect(dbTargetFingerprint("postgresql://u:p@DB.Internal/nova")).toBe(
      dbTargetFingerprint("postgresql://u:p@db.internal/nova"),
    );
  });
  it("3. explicit :5432 ≡ omitted default port", () => {
    expect(dbTargetFingerprint("postgresql://u:p@db.internal:5432/nova")).toBe(
      dbTargetFingerprint("postgresql://u:p@db.internal/nova"),
    );
  });
  it("4. credentials changed but same target ≡ same identity", () => {
    expect(dbTargetFingerprint("postgresql://a:b@db.internal/nova")).toBe(
      dbTargetFingerprint("postgresql://c:d@db.internal/nova"),
    );
  });
  it("5. a TLS-posture difference DOES change identity", () => {
    expect(dbTargetFingerprint("postgresql://u:p@db.internal/nova?sslmode=require")).not.toBe(
      dbTargetFingerprint("postgresql://u:p@db.internal/nova?sslmode=disable"),
    );
  });
  it("6. percent-encoded database name normalizes to the same identity", () => {
    expect(dbTargetFingerprint("postgresql://u:p@db.internal/nova%5Fscratch")).toBe(
      dbTargetFingerprint("postgresql://u:p@db.internal/nova_scratch"),
    );
  });
  it("7. IPv4 and IPv6 hosts are handled and distinct", () => {
    const v4 = dbTargetFingerprint("postgresql://u:p@10.0.0.5:5432/nova");
    const v6 = dbTargetFingerprint("postgresql://u:p@[fe80::1]:5432/nova");
    expect(v4).toMatch(/^[0-9a-f]{64}$/);
    expect(v6).toMatch(/^[0-9a-f]{64}$/);
    expect(v4).not.toBe(v6);
    // IPv6 hex case-folds to the same identity.
    expect(v6).toBe(dbTargetFingerprint("postgresql://u:p@[FE80::1]:5432/nova"));
  });
});

describe("classifyScratchTarget — trailing-dot + run-id contract (P1-3)", () => {
  const RUN_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const base = (over: Record<string, string | undefined> = {}) => {
    const dsn = `postgresql://u:p@render-pg.internal:5432/nova_scratch_${RUN_ID}`;
    const env = {
      NODE_ENV: "test",
      NOVA_VALIDATE_ALLOW_REMOTE_SCRATCH: "yes",
      NOVA_RESTORE_TARGET_CLASS: "scratch",
      NOVA_RESTORE_SCRATCH_CONFIRM: REMOTE_SCRATCH_CONFIRM,
      NOVA_RESTORE_EXPECT_HOST: "render-pg.internal",
      NOVA_RESTORE_EXPECT_DATABASE: `nova_scratch_${RUN_ID}`,
      NOVA_RESTORE_EXPECT_FINGERPRINT: dbTargetFingerprint(dsn),
      NOVA_PRIMARY_DATABASE_FINGERPRINT: dbTargetFingerprint("postgresql://u:p@prod-pg.internal:5432/nova"),
      NOVA_RECOVERY_RUN_ID: RUN_ID,
      ...over,
    } as NodeJS.ProcessEnv;
    return { dsn, env };
  };

  it("8. weak run id (a word like 'nova') → blocked (not 32-hex)", () => {
    const { dsn, env } = base({ NOVA_RECOVERY_RUN_ID: "nova" });
    const c = classifyScratchTarget(dsn, env);
    expect(c.verdict).toBe("blocked");
    expect(c.reasons.join(" ")).toContain("NOVA_RECOVERY_RUN_ID");
  });

  it("9. strong run id present but NOT delimiter-bound (embedded mid-name) → blocked", () => {
    // db name contains the run id but does not END WITH _<run-id>.
    const dsn = `postgresql://u:p@render-pg.internal:5432/x${RUN_ID}_tail`;
    const { env } = base({ NOVA_RESTORE_EXPECT_DATABASE: `x${RUN_ID}_tail` });
    const c = classifyScratchTarget(dsn, env);
    expect(c.verdict).toBe("blocked");
    expect(c.reasons.join(" ")).toContain("END WITH");
  });

  it("10. malformed run id (uppercase / wrong length) → blocked", () => {
    for (const bad of [RUN_ID.toUpperCase(), "abc", "g".repeat(32), RUN_ID + "0"]) {
      const { dsn, env } = base({ NOVA_RECOVERY_RUN_ID: bad });
      expect(classifyScratchTarget(dsn, env).verdict).toBe("blocked");
    }
  });

  it("11. strong, delimiter-bound run id → remote_scratch (PASS)", () => {
    const { dsn, env } = base();
    const c = classifyScratchTarget(dsn, env);
    expect(c.verdict).toBe("remote_scratch");
    expect(c.reasons).toEqual([]);
  });

  it("12. expected host with a trailing dot still matches the target (equivalent)", () => {
    const { dsn, env } = base({ NOVA_RESTORE_EXPECT_HOST: "render-pg.internal." });
    const c = classifyScratchTarget(dsn, env);
    expect(c.verdict).toBe("remote_scratch");
  });

  it("12b. trailing-dot primary-equivalent target → blocked (restore-over-primary refused)", () => {
    // The live target equals the primary once trailing dots are collapsed.
    const primaryDsn = "postgresql://u:p@prod-pg.internal:5432/nova";
    const runId = "abcdef0123456789abcdef0123456789";
    const targetDsn = `postgresql://u:p@prod-pg.internal.:5432/nova`; // trailing dot on host
    const env = {
      NODE_ENV: "test",
      NOVA_VALIDATE_ALLOW_REMOTE_SCRATCH: "yes",
      NOVA_RESTORE_TARGET_CLASS: "scratch",
      NOVA_RESTORE_SCRATCH_CONFIRM: REMOTE_SCRATCH_CONFIRM,
      NOVA_RESTORE_EXPECT_HOST: "prod-pg.internal",
      NOVA_RESTORE_EXPECT_DATABASE: "nova",
      NOVA_RESTORE_EXPECT_FINGERPRINT: dbTargetFingerprint(primaryDsn),
      NOVA_PRIMARY_DATABASE_FINGERPRINT: dbTargetFingerprint(primaryDsn),
      NOVA_RECOVERY_RUN_ID: runId,
    } as NodeJS.ProcessEnv;
    const c = classifyScratchTarget(targetDsn, env);
    expect(c.verdict).toBe("blocked");
    // Both the primary-equality refusal AND the run-id-binding failure apply.
    expect(c.reasons.join(" ")).toContain("EQUALS the primary");
  });
});
