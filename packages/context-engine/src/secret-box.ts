import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

/**
 * Integration-credential encryption (M6). AES-256-GCM with a random 96-bit
 * nonce per encryption; the auth tag detects any tampering. Stored layout:
 *
 *   [1 byte version=1][12 byte iv][16 byte tag][ciphertext]
 *
 * The key comes from NOVA_ENCRYPTION_KEY (32 bytes as 64 hex chars or
 * base64/base64url). Provider tokens are NEVER stored or logged in
 * plaintext; a missing key makes integrations fail closed.
 */

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

/** Parse NOVA_ENCRYPTION_KEY into a 32-byte key. Throws on anything else. */
export function parseEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === KEY_LEN) return decoded;
  } catch {
    /* fall through */
  }
  throw new SecretBoxError(
    "NOVA_ENCRYPTION_KEY must be 32 bytes, as 64 hex chars or base64 (try: openssl rand -hex 32)",
  );
}

export function encryptSecret(key: Buffer, plaintext: string): Buffer {
  if (key.length !== KEY_LEN) throw new SecretBoxError("encryption key must be 32 bytes");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, data]);
}

export function decryptSecret(key: Buffer, box: Buffer): string {
  if (key.length !== KEY_LEN) throw new SecretBoxError("encryption key must be 32 bytes");
  if (box.length < 1 + IV_LEN + TAG_LEN || box[0] !== VERSION) {
    throw new SecretBoxError("unrecognized ciphertext format");
  }
  const iv = box.subarray(1, 1 + IV_LEN);
  const tag = box.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const data = box.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or tampered ciphertext — same error either way, no oracle.
    throw new SecretBoxError("decryption failed (wrong key or corrupted data)");
  }
}
