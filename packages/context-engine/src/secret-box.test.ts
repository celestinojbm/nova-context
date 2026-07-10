import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptBytesWithAny,
  decryptSecret,
  decryptSecretWithAny,
  encryptBytes,
  encryptSecret,
  parseEncryptionKey,
  parseKeyList,
  SecretBoxError,
} from "./secret-box.js";

describe("secret box (integration-token encryption)", () => {
  const key = randomBytes(32);

  it("round-trips a token", () => {
    const box = encryptSecret(key, "secret_notion_token_abc123");
    expect(decryptSecret(key, box)).toBe("secret_notion_token_abc123");
  });

  it("never stores plaintext (ciphertext does not contain the token)", () => {
    const token = "secret_notion_token_plaincheck";
    const box = encryptSecret(key, token);
    expect(box.toString("utf8")).not.toContain(token);
    expect(box.toString("latin1")).not.toContain(token);
  });

  it("produces distinct ciphertexts per call (random nonce)", () => {
    const a = encryptSecret(key, "same");
    const b = encryptSecret(key, "same");
    expect(a.equals(b)).toBe(false);
  });

  it("rejects tampered ciphertext", () => {
    const box = encryptSecret(key, "integrity matters");
    box[box.length - 1]! ^= 0xff;
    expect(() => decryptSecret(key, box)).toThrow(SecretBoxError);
  });

  it("rejects the wrong key", () => {
    const box = encryptSecret(key, "hello");
    expect(() => decryptSecret(randomBytes(32), box)).toThrow(SecretBoxError);
  });

  it("rejects unknown formats", () => {
    expect(() => decryptSecret(key, Buffer.from("junk"))).toThrow(SecretBoxError);
    expect(() => decryptSecret(key, Buffer.concat([Buffer.from([9]), randomBytes(40)]))).toThrow(
      SecretBoxError,
    );
  });

  it("parses hex and base64 keys, rejects bad ones", () => {
    const hex = randomBytes(32).toString("hex");
    expect(parseEncryptionKey(hex).length).toBe(32);
    const b64 = randomBytes(32).toString("base64");
    expect(parseEncryptionKey(b64).length).toBe(32);
    expect(() => parseEncryptionKey("too-short")).toThrow(SecretBoxError);
    expect(() => parseEncryptionKey(randomBytes(16).toString("hex"))).toThrow(SecretBoxError);
  });
});

describe("M11 multi-key read (keyring)", () => {
  it("parses comma-separated key lists", () => {
    const a = randomBytes(32).toString("hex");
    const b = randomBytes(32).toString("base64");
    const keys = parseKeyList(` ${a} , ${b} ,`);
    expect(keys).toHaveLength(2);
    expect(keys[0]!.length).toBe(32);
  });

  it("decrypts with any keyring key; new writes stay new-key-only", () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const oldBox = encryptBytes(oldKey, Buffer.from("old-era"));
    const newBox = encryptBytes(newKey, Buffer.from("new-era"));
    const ring = [newKey, oldKey]; // current first
    expect(decryptBytesWithAny(ring, oldBox).toString()).toBe("old-era");
    expect(decryptBytesWithAny(ring, newBox).toString()).toBe("new-era");
    // A ring without the old key cannot open old data.
    expect(() => decryptBytesWithAny([newKey], oldBox)).toThrow(SecretBoxError);
  });

  it("fails with SecretBoxError when no key fits (no partial output)", () => {
    const box = encryptBytes(randomBytes(32), Buffer.from("locked"));
    expect(() => decryptBytesWithAny([randomBytes(32), randomBytes(32)], box)).toThrow(
      SecretBoxError,
    );
  });

  it("decryptSecretWithAny round-trips strings across the ring", () => {
    const oldKey = randomBytes(32);
    const box = encryptSecret(oldKey, "token-value");
    expect(decryptSecretWithAny([randomBytes(32), oldKey], box)).toBe("token-value");
  });
});
