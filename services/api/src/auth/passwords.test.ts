import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords.js";
import { newSessionToken, sha256Hex } from "./sessions.js";

describe("password hashing", () => {
  it("round-trips a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt$")).toBe(true);
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("right");
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });

  it("rejects null and malformed stored hashes without throwing", async () => {
    await expect(verifyPassword("anything", null)).resolves.toBe(false);
    await expect(verifyPassword("anything", "bcrypt$whatever")).resolves.toBe(false);
    await expect(verifyPassword("anything", "scrypt$bad")).resolves.toBe(false);
  });

  it("salts hashes (same password, different hashes)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });
});

describe("session tokens", () => {
  it("prefixes tokens by audience and generates unique values", () => {
    const web = newSessionToken("web");
    const ext = newSessionToken("extension");
    expect(web.startsWith("nova_sess_")).toBe(true);
    expect(ext.startsWith("nova_ext_")).toBe(true);
    expect(newSessionToken("web")).not.toBe(web);
  });

  it("hashes deterministically", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});
