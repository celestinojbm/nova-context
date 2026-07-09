import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("applies defaults for local dev", () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(3001);
    expect(env.DATABASE_URL).toContain("postgres://");
    expect(env.NOVA_API_TOKEN).toBeUndefined();
  });

  it("treats an empty NOVA_API_TOKEN as unset", () => {
    const env = loadEnv({ NOVA_API_TOKEN: "" });
    expect(env.NOVA_API_TOKEN).toBeUndefined();
  });

  it("rejects a short NOVA_API_TOKEN", () => {
    expect(() => loadEnv({ NOVA_API_TOKEN: "short" })).toThrow(
      /Invalid environment configuration/,
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
