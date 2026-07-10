import { decryptBytes, decryptSecret, encryptSecret, parseEncryptionKey } from "@nova/context-engine/secret-box";
import type { OcrEngine, OcrWord } from "@nova/context-engine/visual-redaction";
import type { FastifyInstance } from "fastify";
import { Jimp, JimpMime } from "jimp";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M9 key rotation v0: the real `media:rotate-key` command run as a child
 * process. Proves dry-run touches nothing, --apply re-encrypts media blobs
 * AND integration tokens from old→new key, reruns are no-ops (resumable),
 * and a wrong old key leaves everything untouched with a non-zero exit.
 */
const databaseUrl = process.env.DATABASE_URL;

const OLD_KEY_HEX = randomBytes(32).toString("hex");
const NEW_KEY_HEX = randomBytes(32).toString("hex");
const OLD_KEY = parseEncryptionKey(OLD_KEY_HEX);
const NEW_KEY = parseEncryptionKey(NEW_KEY_HEX);

class CleanOcr implements OcrEngine {
  readonly name = "clean";
  async recognize(): Promise<{ words: OcrWord[] }> {
    return { words: [{ text: "hello", x0: 0, y0: 0, x1: 50, y1: 20 }] };
  }
}

describe.skipIf(!databaseUrl)("M9: key rotation", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let user: TestUser;
  let storageKey: string;
  let thumbKey: string;
  const fsRoot = join(tmpdir(), `nova-rotate-test-${Date.now()}`);

  function runRotate(env: Record<string, string>, apply: boolean): { out: string; status: number } {
    try {
      const out = execFileSync(
        "pnpm",
        ["exec", "tsx", "src/db/rotate-media-key.ts", ...(apply ? ["--apply"] : [])],
        {
          cwd: join(import.meta.dirname, "..", ".."),
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            NOVA_MEDIA_STORE: "fs",
            NOVA_MEDIA_FS_ROOT: fsRoot,
            ...env,
          },
        },
      );
      return { out, status: 0 };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, status: e.status ?? 1 };
    }
  }

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: OLD_KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
      }),
      ocr: new CleanOcr(),
    });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    user = await createUser(app, `rotate-${Date.now()}@test.local`);

    const img = new Jimp({ width: 400, height: 120, color: 0xffffffff });
    const png = `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://rotate.example.com", title: "Rotate" },
        payload: { screenshot_data_url: png },
        extracted_text: "rotation fixture",
        intent_text: null,
      },
    });
    expect(res.statusCode).toBe(201);
    const row = await db.query<{ storage_key: string; thumb_key: string }>(
      `SELECT storage_key, thumb_key FROM moment_media WHERE user_id = $1`,
      [user.userId],
    );
    storageKey = row.rows[0]!.storage_key;
    thumbKey = row.rows[0]!.thumb_key;

    // An integration token encrypted with the OLD key rotates too.
    await db.query(
      `INSERT INTO integration_connections (user_id, provider, external_account, token_ciphertext, status)
       VALUES ($1, 'notion', 'Rotate WS', $2, 'active')`,
      [user.userId, encryptSecret(OLD_KEY, "secret_rotate_token_123")],
    );
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  // NOTE on exit codes: the shared test database carries rows from other
  // suites encrypted with their own throwaway keys, which the command
  // rightly reports as undecryptable (exit 2). Assertions therefore target
  // the rows THIS suite owns, not the global exit status.
  it("dry run reports work but modifies nothing", async () => {
    const { out } = runRotate(
      { NOVA_ENCRYPTION_KEY: NEW_KEY_HEX, NOVA_ENCRYPTION_KEY_OLD: OLD_KEY_HEX },
      false,
    );
    expect(out).toContain("dry run");
    const blob = await readFile(join(fsRoot, storageKey));
    expect(decryptBytes(OLD_KEY, blob).subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(() => decryptBytes(NEW_KEY, blob)).toThrow();
  });

  it("a wrong old key rotates nothing and exits non-zero", async () => {
    const bogus = randomBytes(32).toString("hex");
    const { out, status } = runRotate(
      { NOVA_ENCRYPTION_KEY: NEW_KEY_HEX, NOVA_ENCRYPTION_KEY_OLD: bogus },
      true,
    );
    expect(status).toBe(2); // undecryptable items reported
    expect(out).toContain("undecryptable");
    // Blob is untouched and still opens with the REAL old key.
    const blob = await readFile(join(fsRoot, storageKey));
    expect(decryptBytes(OLD_KEY, blob).subarray(1, 4).toString("latin1")).toBe("PNG");
    // Plaintext never leaked into output.
    expect(out).not.toContain("secret_rotate_token_123");
  });

  it("--apply re-encrypts blobs and tokens; rerun is a no-op (resumable)", async () => {
    runRotate({ NOVA_ENCRYPTION_KEY: NEW_KEY_HEX, NOVA_ENCRYPTION_KEY_OLD: OLD_KEY_HEX }, true);

    // Old key no longer opens the media; the new one does. Same for thumbs.
    const blob = await readFile(join(fsRoot, storageKey));
    expect(() => decryptBytes(OLD_KEY, blob)).toThrow();
    expect(decryptBytes(NEW_KEY, blob).subarray(1, 4).toString("latin1")).toBe("PNG");
    const thumb = await readFile(join(fsRoot, thumbKey));
    expect(() => decryptBytes(OLD_KEY, thumb)).toThrow();
    expect(decryptBytes(NEW_KEY, thumb)).toBeTruthy();

    // Integration token rotated in place.
    const token = await db.query<{ token_ciphertext: Buffer }>(
      `SELECT token_ciphertext FROM integration_connections WHERE user_id = $1`,
      [user.userId],
    );
    expect(decryptSecret(NEW_KEY, token.rows[0]!.token_ciphertext)).toBe(
      "secret_rotate_token_123",
    );

    // Rerun: everything already on the new key — safe, nothing re-rotated.
    const rerun = runRotate(
      { NOVA_ENCRYPTION_KEY: NEW_KEY_HEX, NOVA_ENCRYPTION_KEY_OLD: OLD_KEY_HEX },
      true,
    );
    expect(rerun.out).toMatch(/media already on new key:\s+[1-9]/);
    const blobAfter = await readFile(join(fsRoot, storageKey));
    expect(decryptBytes(NEW_KEY, blobAfter)).toBeTruthy();

    // The API can serve the media again once configured with the new key.
    const rotatedApp = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: NEW_KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
      }),
      ocr: null,
    });
    await rotatedApp.ready();
    try {
      const login = await rotatedApp.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: user.email, password: "integration-test-password" },
      });
      const mediaId = (
        await db.query<{ id: string }>(`SELECT id FROM moment_media WHERE user_id = $1`, [
          user.userId,
        ])
      ).rows[0]!.id;
      const res = await rotatedApp.inject({
        method: "GET",
        url: `/v1/media/${mediaId}`,
        headers: { authorization: `Bearer ${login.json().token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.subarray(1, 4).toString("latin1")).toBe("PNG");
    } finally {
      await rotatedApp.close();
    }
  });
});
