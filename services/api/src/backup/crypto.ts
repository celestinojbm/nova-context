import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";

/**
 * M15 (Hermes P1): authenticated encryption for backup artifacts.
 *
 * Backups are AES-256-GCM sealed with NOVA_BACKUP_KEY — a key that is
 * SEPARATE from the data-at-rest key (NOVA_ENCRYPTION_KEY) and is NEVER
 * written into the backup. GCM's auth tag makes tampering and wrong-key use
 * fail loudly at decrypt time; the manifest additionally records the sha256
 * of each sealed artifact so integrity can be checked WITHOUT the key.
 *
 * On-disk sealed format (streaming-friendly, tag at the end):
 *   [12-byte IV][ciphertext …][16-byte GCM tag]
 */

const IV_LEN = 12;
const TAG_LEN = 16;

export function parseBackupKey(value: string | undefined): Buffer {
  if (!value) throw new Error("NOVA_BACKUP_KEY is required (32 bytes, hex or base64)");
  const trimmed = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error("NOVA_BACKUP_KEY must decode to 32 bytes (hex or base64)");
  }
  return key;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path);
    s.on("data", (c) => hash.update(c));
    s.on("end", () => resolve());
    s.on("error", reject);
  });
  return hash.digest("hex");
}

/** Encrypt inPath → outPath (0600). Streams; tag appended after ciphertext. */
export async function encryptFile(inPath: string, outPath: string, key: Buffer): Promise<void> {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const src = createReadStream(inPath);
  const dest = createWriteStream(outPath, { mode: 0o600 });
  await new Promise<void>((resolve, reject) => {
    const fail = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)));
    src.on("error", fail);
    cipher.on("error", fail);
    dest.on("error", fail);
    cipher.on("data", (chunk: Buffer) => {
      if (!dest.write(chunk)) {
        cipher.pause();
        dest.once("drain", () => cipher.resume());
      }
    });
    cipher.on("end", () => {
      dest.end(cipher.getAuthTag(), () => resolve());
    });
    dest.write(iv);
    src.pipe(cipher);
  });
}

/**
 * Decrypt inPath → outPath (0600). Throws on a wrong key or any tampering
 * (GCM tag mismatch surfaces from decipher.final()). Returns nothing on
 * success; the caller treats a throw as "cannot restore this artifact".
 */
export async function decryptFile(inPath: string, outPath: string, key: Buffer): Promise<void> {
  const { size } = await stat(inPath);
  if (size < IV_LEN + TAG_LEN) {
    throw new Error("sealed artifact is too small to be valid");
  }
  const fh = await open(inPath, "r");
  let iv: Buffer;
  let tag: Buffer;
  try {
    iv = Buffer.alloc(IV_LEN);
    await fh.read(iv, 0, IV_LEN, 0);
    tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    await fh.close();
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dest = createWriteStream(outPath, { mode: 0o600 });
  // Read only the ciphertext middle: [IV_LEN .. size-TAG_LEN-1] inclusive.
  const src = createReadStream(inPath, { start: IV_LEN, end: size - TAG_LEN - 1 });
  await new Promise<void>((resolve, reject) => {
    const fail = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)));
    src.on("error", fail);
    decipher.on("error", fail);
    dest.on("error", fail);
    dest.on("finish", () => resolve());
    src.pipe(decipher).pipe(dest);
  });
}

/** Confirm a sealed artifact decrypts (auth tag valid) without writing
 * plaintext — used by backup:verify. Returns true, or throws. */
export async function assertDecryptable(inPath: string, key: Buffer): Promise<true> {
  const { size } = await stat(inPath);
  if (size < IV_LEN + TAG_LEN) throw new Error("sealed artifact is too small to be valid");
  const fh = await open(inPath, "r");
  let iv: Buffer;
  let tag: Buffer;
  try {
    iv = Buffer.alloc(IV_LEN);
    await fh.read(iv, 0, IV_LEN, 0);
    tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    await fh.close();
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  await new Promise<void>((resolve, reject) => {
    const src = createReadStream(inPath, { start: IV_LEN, end: size - TAG_LEN - 1 });
    src.on("error", reject);
    decipher.on("error", reject); // tag mismatch → throws here
    decipher.on("data", () => {
      /* discard plaintext */
    });
    decipher.on("end", () => resolve());
    src.pipe(decipher);
  });
  return true;
}

export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
