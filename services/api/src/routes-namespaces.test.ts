import { describe, expect, it } from "vitest";
import { isLockTimeout } from "./routes-namespaces.js";

describe("isLockTimeout (M20h)", () => {
  it("recognises Postgres lock_not_available (55P03) only", () => {
    expect(isLockTimeout(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }))).toBe(true);
    expect(isLockTimeout(Object.assign(new Error("deadlock detected"), { code: "40P01" }))).toBe(false);
    expect(isLockTimeout(new Error("boom"))).toBe(false);
    expect(isLockTimeout(null)).toBe(false);
    expect(isLockTimeout("55P03")).toBe(false);
  });
});
