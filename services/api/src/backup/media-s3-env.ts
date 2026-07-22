import { realpath } from "node:fs/promises";
import { FsObjectStore, S3ObjectStore, storeFromEnv } from "../media/object-store.js";
import type { Env } from "../env.js";
import type { StoreTarget } from "./media-s3.js";

/**
 * M18A: turn environment into the SOURCE (primary media) and BACKUP store
 * targets for the media-s3 commands. The backup destination is configured
 * with its own env names (a SEPARATE bucket, optionally separate scoped
 * credentials — recommended for R2):
 *
 *   NOVA_BACKUP_S3_BUCKET             (required; must differ from the media bucket)
 *   NOVA_BACKUP_S3_REGION             (default: media region)
 *   NOVA_BACKUP_S3_ENDPOINT           (default: media endpoint)
 *   NOVA_BACKUP_S3_ACCESS_KEY_ID      (default: media access key)
 *   NOVA_BACKUP_S3_SECRET_ACCESS_KEY  (default: media secret)
 *
 * Identity strings never leave the process (only sha256 fingerprints are
 * persisted); values are never printed.
 */

export async function primaryTarget(env: Env): Promise<StoreTarget> {
  if (env.NOVA_MEDIA_STORE === "s3") {
    return {
      store: storeFromEnv(env),
      identity: `s3|${env.NOVA_MEDIA_S3_ENDPOINT ?? "aws"}|${env.NOVA_MEDIA_S3_BUCKET}`,
    };
  }
  // fs source is allowed for local drills/tests; identity uses the physical
  // root so a symlinked alias still fingerprints identically.
  const root = await realpath(env.NOVA_MEDIA_FS_ROOT).catch(() => env.NOVA_MEDIA_FS_ROOT);
  return { store: new FsObjectStore(env.NOVA_MEDIA_FS_ROOT), identity: `fs|${root}` };
}

export function backupTarget(env: Env, processEnv: NodeJS.ProcessEnv): StoreTarget {
  const bucket = processEnv.NOVA_BACKUP_S3_BUCKET;
  if (!bucket) {
    throw new Error(
      "NOVA_BACKUP_S3_BUCKET is required (a SEPARATE bucket from the primary media store).",
    );
  }
  const endpoint = processEnv.NOVA_BACKUP_S3_ENDPOINT || env.NOVA_MEDIA_S3_ENDPOINT;
  const region = processEnv.NOVA_BACKUP_S3_REGION || env.NOVA_MEDIA_S3_REGION;
  const accessKeyId = processEnv.NOVA_BACKUP_S3_ACCESS_KEY_ID || env.NOVA_MEDIA_S3_ACCESS_KEY_ID;
  const secretAccessKey =
    processEnv.NOVA_BACKUP_S3_SECRET_ACCESS_KEY || env.NOVA_MEDIA_S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "backup store credentials missing: set NOVA_BACKUP_S3_ACCESS_KEY_ID/SECRET_ACCESS_KEY " +
        "(or configure the media s3 credentials they fall back to).",
    );
  }
  return {
    store: new S3ObjectStore({ bucket, region, endpoint, accessKeyId, secretAccessKey }),
    identity: `s3|${endpoint ?? "aws"}|${bucket}`,
  };
}
