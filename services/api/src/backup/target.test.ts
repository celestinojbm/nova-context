import { describe, expect, it } from "vitest";
import { classifyRestoreTarget, redactDatabaseUrl } from "./target.js";

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
