import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";
import { opsStatus, toPublicReadiness, type OpsDeps } from "./routes-ops.js";

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

describe("opsStatus sanitizes dependency errors (Hermes D05)", () => {
  it("authenticated status body reveals no hosts/ports/paths/bucket names/raw errors", async () => {
    // Every dependency throws a message stuffed with things that must not
    // leak to the response (they belong only in the request-scoped log).
    const DB_ERR = "connect ECONNREFUSED 10.9.9.9:5432 nova_prod";
    const REDIS_ERR = "getaddrinfo ENOTFOUND redis.internal.secret:6379";
    const STORE_ERR = "AccessDenied bucket=my-secret-bucket path=/var/secret/media";

    const throwingDb = {
      query: async () => {
        throw new Error(DB_ERR);
      },
    } as unknown as OpsDeps["db"];
    const throwingRedis = {
      get: async () => {
        throw new Error(REDIS_ERR);
      },
      ping: async () => {
        throw new Error(REDIS_ERR);
      },
    } as unknown as OpsDeps["redis"];
    const throwingStore = {
      put: async () => {
        throw new Error(STORE_ERR);
      },
      get: async () => {
        throw new Error(STORE_ERR);
      },
      delete: async () => {
        throw new Error(STORE_ERR);
      },
    } as unknown as OpsDeps["store"];

    const logged: Array<Record<string, unknown>> = [];
    const status = await opsStatus(
      {
        db: throwingDb,
        env: loadEnv({}),
        redis: throwingRedis,
        enrichmentQueue: null,
        actionQueue: null,
        store: throwingStore,
        mediaAvailable: true,
      },
      { warn: (obj) => logged.push(obj) },
    );

    const body = JSON.stringify(status);
    for (const leak of [
      "ECONNREFUSED",
      "10.9.9.9",
      "5432",
      "ENOTFOUND",
      "redis.internal.secret",
      "6379",
      "my-secret-bucket",
      "/var/secret/media",
      "AccessDenied",
    ]) {
      expect(body).not.toContain(leak);
    }
    // But the raw detail WAS captured for the operator's structured log.
    expect(JSON.stringify(logged)).toContain("ECONNREFUSED");
  });
});
