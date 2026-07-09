import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

/**
 * Object storage abstraction (M8). Deliberately tiny — put/get/delete of
 * opaque encrypted blobs — so no provider owns us:
 *   - FsObjectStore: local filesystem (development default, tests)
 *   - S3ObjectStore: any S3-compatible API (MinIO locally, S3/R2 in prod)
 * Blobs are ALWAYS ciphertext (AES-256-GCM via secret-box) before they
 * reach a store; the store never sees plaintext captured pixels.
 */
export interface ObjectStore {
  readonly name: string;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
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
}

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string; // MinIO/R2; unset = AWS
  accessKeyId: string;
  secretAccessKey: string;
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
}
