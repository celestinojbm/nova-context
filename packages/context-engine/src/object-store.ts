import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";

/**
 * Object storage abstraction (M8). Deliberately tiny — put/get/delete of
 * opaque encrypted blobs — so no provider owns us:
 *   - FsObjectStore: local filesystem (development default, tests)
 *   - S3ObjectStore: any S3-compatible API (MinIO locally, S3/R2 in prod)
 * Blobs are ALWAYS ciphertext (AES-256-GCM via secret-box) before they
 * reach a store; the store never sees plaintext captured pixels.
 */
export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date | null;
}

export interface ObjectStore {
  readonly name: string;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  /** Every object under the prefix (M9 orphan cleanup). Loads the full key
   * list into memory — fine at alpha scale; revisit before millions. */
  list(prefix?: string): Promise<StoredObject[]>;
}

export class FsObjectStore implements ObjectStore {
  readonly name = "fs";
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    const safe = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
    const full = join(this.root, safe);
    if (!full.startsWith(normalize(this.root))) {
      throw new Error("object key escapes the store root");
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async list(prefix = ""): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") return;
        throw err;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          const key = relative(this.root, full).split(sep).join("/");
          if (!key.startsWith(prefix)) continue;
          const info = await stat(full);
          out.push({ key, size: info.size, lastModified: info.mtime });
        }
      }
    };
    await walk(this.root);
    return out;
  }
}

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string; // MinIO/R2; unset = AWS
  accessKeyId: string;
  secretAccessKey: string;
}

/** Structural slice of Env so this module stays dependency-free. */
export interface MediaStoreEnv {
  NOVA_MEDIA_STORE: "fs" | "s3";
  NOVA_MEDIA_FS_ROOT: string;
  NOVA_MEDIA_S3_BUCKET?: string;
  NOVA_MEDIA_S3_REGION: string;
  NOVA_MEDIA_S3_ENDPOINT?: string;
  NOVA_MEDIA_S3_ACCESS_KEY_ID?: string;
  NOVA_MEDIA_S3_SECRET_ACCESS_KEY?: string;
}

/** One place to turn env into a store (app + operator commands). */
export function storeFromEnv(env: MediaStoreEnv): ObjectStore {
  return env.NOVA_MEDIA_STORE === "s3"
    ? new S3ObjectStore({
        bucket: env.NOVA_MEDIA_S3_BUCKET!,
        region: env.NOVA_MEDIA_S3_REGION,
        endpoint: env.NOVA_MEDIA_S3_ENDPOINT,
        accessKeyId: env.NOVA_MEDIA_S3_ACCESS_KEY_ID!,
        secretAccessKey: env.NOVA_MEDIA_S3_SECRET_ACCESS_KEY!,
      })
    : new FsObjectStore(env.NOVA_MEDIA_FS_ROOT);
}

export class S3ObjectStore implements ObjectStore {
  readonly name = "s3";
  private clientPromise: Promise<import("@aws-sdk/client-s3").S3Client> | null = null;

  constructor(private readonly cfg: S3Config) {}

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { S3Client } = await import("@aws-sdk/client-s3");
        return new S3Client({
          region: this.cfg.region,
          ...(this.cfg.endpoint
            ? { endpoint: this.cfg.endpoint, forcePathStyle: true }
            : {}),
          credentials: {
            accessKeyId: this.cfg.accessKeyId,
            secretAccessKey: this.cfg.secretAccessKey,
          },
        });
      })();
    }
    return this.clientPromise;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.client()).send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: data,
        ContentType: "application/octet-stream", // ciphertext, not an image
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    const { GetObjectCommand, NoSuchKey } = await import("@aws-sdk/client-s3");
    try {
      const res = await (await this.client()).send(
        new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      );
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch (err) {
      if (
        err instanceof NoSuchKey ||
        (err as { name?: string }).name === "NoSuchKey" ||
        (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        return null;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.client()).send(
      new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
    );
  }

  async list(prefix = ""): Promise<StoredObject[]> {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const client = await this.client();
    const out: StoredObject[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await client.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: prefix || undefined,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        out.push({
          key: obj.Key,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified ?? null,
        });
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Object-store identity guards (M18A.1).
//
// A "store identity" is a stable string describing WHERE a store points:
//   s3|<endpoint>|<bucket>   or   fs|<physical-path>
// Its sha256 fingerprint is a SAFETY GUARD used to refuse source/backup/
// scratch ALIASING (e.g. backing up onto the same bucket, or restoring over
// the primary). It is NOT proof of provider-account identity or ownership —
// two configs that canonicalize to the same string are treated as the same
// physical store so trailing-slash / port / casing variants cannot bypass the
// separation checks.
// ---------------------------------------------------------------------------

/** Normalize an S3 endpoint: lowercase scheme+host, drop default ports, strip
 * trailing slashes. `aws`/empty (no explicit endpoint) canonicalizes to
 * "aws". */
export function canonicalizeEndpoint(endpoint: string | undefined): string {
  const raw = (endpoint ?? "").trim();
  if (!raw || raw.toLowerCase() === "aws") return "aws";
  try {
    const u = new URL(raw);
    const scheme = u.protocol.toLowerCase(); // includes trailing ':'
    const host = u.hostname.toLowerCase();
    const isDefaultPort =
      (scheme === "https:" && (u.port === "443" || u.port === "")) ||
      (scheme === "http:" && (u.port === "80" || u.port === ""));
    const portPart = u.port && !isDefaultPort ? `:${u.port}` : "";
    const path = u.pathname.replace(/\/+$/, "");
    return `${scheme}//${host}${portPart}${path}`;
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

/** Build an s3 store identity string from endpoint + bucket. */
export function s3Identity(endpoint: string | undefined, bucket: string): string {
  return `s3|${endpoint ?? "aws"}|${bucket}`;
}

/** Build an fs store identity string from a (ideally physical) path. */
export function fsIdentity(path: string): string {
  return `fs|${path}`;
}

/** Canonical form of a store identity string. Endpoint is normalized; a
 * trailing slash on the fs path is dropped; the bucket is trimmed (bucket
 * names are case-sensitive so casing is preserved). Unknown shapes pass
 * through unchanged. */
export function canonicalizeIdentity(identity: string): string {
  const parts = identity.split("|");
  if (parts[0] === "s3" && parts.length >= 3) {
    const endpoint = canonicalizeEndpoint(parts[1]);
    const bucket = parts.slice(2).join("|").trim().replace(/\/+$/, "");
    return `s3|${endpoint}|${bucket}`;
  }
  if (parts[0] === "fs" && parts.length >= 2) {
    const path = parts.slice(1).join("|").replace(/\/+$/, "") || "/";
    return `fs|${path}`;
  }
  return identity;
}

/** sha256 of the CANONICAL identity — the aliasing-guard fingerprint. */
export function fingerprintIdentity(identity: string): string {
  return createHash("sha256").update(canonicalizeIdentity(identity)).digest("hex");
}
