import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

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
    const env = loadEnv({ NODE_ENV: "production" });
    expect(env.isProduction).toBe(true);
    expect(env.signupMode).toBe("invite");
  });

  it("honors an explicit NOVA_SIGNUP", () => {
    expect(loadEnv({ NODE_ENV: "production", NOVA_SIGNUP: "closed" }).signupMode).toBe("closed");
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
});
