import { describe, expect, it } from "vitest";
import { REDACTED, sanitize } from "../src/sanitization.js";

describe("output sanitization (M17B §8)", () => {
  it("redacts DSN credentials (postgres/redis, any scheme)", () => {
    const out = sanitize(
      "connecting to postgres://admin:sup3rs3cretpw@db.internal:5432/nova and redis://:r3d1spw@cache:6379",
    );
    expect(out).not.toContain("sup3rs3cretpw");
    expect(out).not.toContain("r3d1spw");
    expect(out).toContain(`postgres://${REDACTED}@db.internal:5432/nova`);
  });

  it("redacts known secret env values exactly (stdout AND stderr paths use the same fn)", () => {
    const env = { NOVA_BACKUP_KEY: "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344" };
    const out = sanitize(`error: key aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344 rejected`, {
      env: env as NodeJS.ProcessEnv,
    });
    expect(out).not.toContain("aabbccdd11223344");
    expect(out).toContain(REDACTED);
  });

  it("redacts 32-byte hex keys by shape even when not in env", () => {
    const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(sanitize(`NOVA_ENCRYPTION_KEY=${key}`)).not.toContain(key);
  });

  it("redacts bearer/session tokens and cookies", () => {
    const out = sanitize(
      "authorization: Bearer sess_4f9a8b7c6d5e4f3a2b1c\ncookie: nova_session=abc123def456; theme=dark\nsession_token=deadbeefcafe1234",
    );
    expect(out).not.toContain("sess_4f9a8b7c6d5e4f3a2b1c");
    expect(out).not.toContain("abc123def456");
    expect(out).not.toContain("deadbeefcafe1234");
  });

  it("redacts provider API keys (OpenAI/Anthropic/GitHub/AWS)", () => {
    const out = sanitize(
      "keys: sk-proj-abc123def456ghi789jkl sk-ant-api03-xyz987wvu654 ghp_abcdefghijklmnopqrstuv123456 AKIAIOSFODNN7EXAMPLE",
    );
    expect(out).not.toContain("sk-proj-");
    expect(out).not.toContain("sk-ant-");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("never lets captured data URLs (any case) reach a report", () => {
    const out = sanitize('payload: {"screenshot":"DATA:image/png;base64,iVBORw0KGgoAAAANS"} and data:image/svg+xml,<svg/>');
    expect(out).not.toMatch(/data:image/i);
    expect(out).toContain("[REDACTED_DATA_URL]");
  });

  it("redacts secrets inside thrown-error-style text and command descriptions", () => {
    const out = sanitize("Error: connect failed for postgres://nova:hunter22pass@10.0.0.5/nova (invite_code=alpha-XYZ-123)");
    expect(out).not.toContain("hunter22pass");
    expect(out).not.toContain("alpha-XYZ-123");
  });

  it("redacts private key blocks", () => {
    const out = sanitize("-----BEGIN RSA PRIVATE KEY-----\nMIIEow…\n-----END RSA PRIVATE KEY-----");
    expect(out).not.toContain("MIIEow");
  });
});
