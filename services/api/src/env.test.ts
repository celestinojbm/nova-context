import { describe, expect, it } from "vitest";
import { loadEnv, securitySummary } from "./env.js";

describe("loadEnv", () => {
  it("applies defaults for local dev", () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(3001);
    expect(env.DATABASE_URL).toContain("postgres://");
    expect(env.isProduction).toBe(false);
    expect(env.signupMode).toBe("open");
    expect(env.NOVA_SESSION_TTL_HOURS).toBe(168);
    expect(env.NOVA_EXTENSION_SESSION_TTL_HOURS).toBe(720);
  });

  it("defaults signup to invite-only in production", () => {
    const env = loadEnv({ NODE_ENV: "production", NOVA_ENCRYPTION_KEY: "a".repeat(64) });
    expect(env.isProduction).toBe(true);
    expect(env.signupMode).toBe("invite");
  });

  it("production without NOVA_ENCRYPTION_KEY fails closed at boot (M8)", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/NOVA_ENCRYPTION_KEY/);
  });

  it("s3 media store requires its credentials", () => {
    expect(() => loadEnv({ NOVA_MEDIA_STORE: "s3" })).toThrow(/NOVA_MEDIA_S3_BUCKET/);
    const env = loadEnv({
      NOVA_MEDIA_STORE: "s3",
      NOVA_MEDIA_S3_BUCKET: "nova-media",
      NOVA_MEDIA_S3_ACCESS_KEY_ID: "minio",
      NOVA_MEDIA_S3_SECRET_ACCESS_KEY: "minio-secret",
    });
    expect(env.NOVA_MEDIA_STORE).toBe("s3");
  });

  it("honors an explicit NOVA_SIGNUP", () => {
    expect(
      loadEnv({
        NODE_ENV: "production",
        NOVA_SIGNUP: "closed",
        NOVA_ENCRYPTION_KEY: "a".repeat(64),
      }).signupMode,
    ).toBe("closed");
    expect(
      loadEnv({ NOVA_SIGNUP: "invite", NOVA_ALPHA_INVITE_CODE: "alpha-code-1" }).signupMode,
    ).toBe("invite");
  });

  it("fails closed in production when Notion is configured without an encryption key", () => {
    expect(() =>
      loadEnv({ NODE_ENV: "production", NOTION_CLIENT_ID: "notion-client-1" }),
    ).toThrow(/NOVA_ENCRYPTION_KEY/);
    // With a key it boots.
    const env = loadEnv({
      NODE_ENV: "production",
      NOTION_CLIENT_ID: "notion-client-1",
      NOVA_ENCRYPTION_KEY: "a".repeat(64),
    });
    expect(env.NOTION_CLIENT_ID).toBe("notion-client-1");
  });

  it("rejects a plaintext-HTTP Notion redirect URI in production", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        NOTION_CLIENT_ID: "notion-client-1",
        NOVA_ENCRYPTION_KEY: "a".repeat(64),
        NOTION_REDIRECT_URI: "http://insecure.example.com/callback",
      }),
    ).toThrow(/https/);
  });

  it("summarizes the security posture for boot logs", () => {
    const summary = securitySummary(loadEnv({}));
    expect(summary).toContain("mode=development");
    expect(summary).toContain("signup=open");
    expect(summary).toContain("token_encryption=OFF");
    expect(summary).toContain("media=UNAVAILABLE (no key)");
    expect(summary).toContain("image_redaction=on");
    expect(summary).toContain("rate_limit=in-memory");
  });

  it("rejects invite mode without a code in development", () => {
    expect(() => loadEnv({ NOVA_SIGNUP: "invite" })).toThrow(
      /NOVA_ALPHA_INVITE_CODE/,
    );
  });

  it("rejects a malformed DATABASE_URL", () => {
    expect(() => loadEnv({ DATABASE_URL: "not a url" })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("coerces PORT from string", () => {
    expect(loadEnv({ PORT: "8080" }).PORT).toBe(8080);
  });

  // M13: unsafe production settings fail closed unless acknowledged.
  it("refuses redaction=off in production without explicit acknowledgement", () => {
    const base = { NODE_ENV: "production", NOVA_ENCRYPTION_KEY: "a".repeat(64) };
    expect(() => loadEnv({ ...base, NOVA_REDACTION: "off" })).toThrow(
      /NOVA_ALLOW_UNSAFE_REDACTION/,
    );
    expect(() => loadEnv({ ...base, NOVA_IMAGE_REDACTION: "off" })).toThrow(
      /NOVA_ALLOW_UNSAFE_REDACTION/,
    );
    // Explicit acknowledgement boots (the operator made a named decision).
    expect(
      loadEnv({ ...base, NOVA_REDACTION: "off", NOVA_ALLOW_UNSAFE_REDACTION: "yes" })
        .NOVA_REDACTION,
    ).toBe("off");
    // Development stays permissive (tests and local experiments).
    expect(loadEnv({ NOVA_REDACTION: "off" }).NOVA_REDACTION).toBe("off");
  });

  it("M13 guardrail defaults: request timeout and media warn threshold", () => {
    const env = loadEnv({});
    expect(env.NOVA_REQUEST_TIMEOUT_MS).toBe(60_000);
    expect(env.NOVA_MEDIA_WARN_MB).toBe(1024);
    expect(loadEnv({ NOVA_MEDIA_WARN_MB: "5" }).NOVA_MEDIA_WARN_MB).toBe(5);
  });
});
