import { describe, expect, it } from "vitest";
import { toPublicReadiness } from "./routes-ops.js";

/**
 * M15 (Hermes P3): the public /readyz body must expose stable booleans only
 * — never the internal error strings that can carry hostnames, paths, or
 * ports. This tests the pure stripping function the /readyz handler uses.
 */
describe("toPublicReadiness (public /readyz shape)", () => {
  it("keeps only per-component booleans + overall ready; drops error/detail", () => {
    const internal = {
      ready: false,
      checks: {
        postgres: { ok: false, error: "connect ECONNREFUSED 10.4.2.7:5432" },
        redis: { ok: false, error: "getaddrinfo ENOTFOUND redis.internal.example" },
        migrations: { ok: false, detail: "3 pending" },
        media_store: { ok: true },
      },
    };
    const pub = toPublicReadiness(internal);
    expect(pub).toEqual({
      ready: false,
      checks: {
        postgres: { ok: false },
        redis: { ok: false },
        migrations: { ok: false },
        media_store: { ok: true },
      },
    });
    // The serialized public body reveals none of the internal detail.
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain("10.4.2.7");
    expect(serialized).not.toContain("redis.internal.example");
    expect(serialized).not.toContain("pending");
    expect(serialized).not.toContain("error");
    expect(serialized).not.toContain("detail");
  });
});
