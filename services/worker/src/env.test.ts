import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("worker env — M20c consolidation is safe by default", () => {
  it("defaults to dry-run with no nightly job", () => {
    const env = loadEnv({});
    expect(env.NOVA_CONSOLIDATION_MODE).toBe("dry-run");
    expect(env.NOVA_CONSOLIDATION_CRON).toBeUndefined();
    expect(env.NOVA_CONSOLIDATION_QUEUE).toBe("memory-consolidation");
  });

  it("blank or whitespace cron means no nightly job", () => {
    expect(loadEnv({ NOVA_CONSOLIDATION_CRON: "" }).NOVA_CONSOLIDATION_CRON).toBeUndefined();
    expect(loadEnv({ NOVA_CONSOLIDATION_CRON: "   " }).NOVA_CONSOLIDATION_CRON).toBeUndefined();
    expect(loadEnv({ NOVA_CONSOLIDATION_CRON: " 0 3 * * * " }).NOVA_CONSOLIDATION_CRON).toBe("0 3 * * *");
  });

  it("apply must be explicit; any other value fails closed", () => {
    expect(loadEnv({ NOVA_CONSOLIDATION_MODE: "apply" }).NOVA_CONSOLIDATION_MODE).toBe("apply");
    expect(() => loadEnv({ NOVA_CONSOLIDATION_MODE: "APPLY" })).toThrow();
  });
});
