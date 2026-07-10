import {
  decryptBytesWithAny,
  parseEncryptionKey,
} from "@nova/context-engine/secret-box";
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
 * M11 suite: multi-key read mode — the zero-downtime rotation story.
 * Media written under an OLD key stays readable once that key moves to
 * NOVA_ENCRYPTION_KEYS_PREVIOUS; new writes use the new key; gradual
 * re-encryption works while both serve; nothing decrypts when no
 * configured key fits.
 */
const databaseUrl = process.env.DATABASE_URL;

const OLD_KEY_HEX = randomBytes(32).toString("hex");
const NEW_KEY_HEX = randomBytes(32).toString("hex");
const NEW_KEY = parseEncryptionKey(NEW_KEY_HEX);
const OLD_KEY = parseEncryptionKey(OLD_KEY_HEX);

class CleanOcr implements OcrEngine {
  readonly name = "clean";
  async recognize(): Promise<{ words: OcrWord[] }> {
    return { words: [{ text: "hello", x0: 0, y0: 0, x1: 40, y1: 20 }] };
  }
}

async function whitePng(): Promise<string> {
  const img = new Jimp({ width: 400, height: 120, color: 0xffffffff });
  return `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;
}

describe.skipIf(!databaseUrl)("M11: multi-key media read", () => {
  let db: pg.Client;
  let fsRoot: string;
  let oldApp: FastifyInstance;
  let email: string;
  let oldMediaId: string;
  let oldStorageKey: string;

  async function login(app: FastifyInstance): Promise<TestUser> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "integration-test-password" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    return {
      token: body.token,
      userId: body.user.id,
      email,
      inject: (opts) =>
        app.inject({
          ...opts,
          headers: { authorization: `Bearer ${body.token}`, ...(opts.headers ?? {}) },
        } as never) as never,
    };
  }

  beforeAll(async () => {
    await migrate(databaseUrl!);
    fsRoot = join(tmpdir(), `nova-multikey-${Date.now()}`);
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();

    // Era 1: the OLD key is current; a capture stores media under it.
    oldApp = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: OLD_KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
      }),
      ocr: new CleanOcr(),
    });
    await oldApp.ready();
    email = `multikey-${Date.now()}@test.local`;
    const user = await createUser(oldApp, email);
    const capture = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: "https://rotate.example.com/old", title: "Old Era" },
        payload: { screenshot_data_url: await whitePng() },
        extracted_text: "old era capture",
        intent_text: null,
      },
    });
    expect(capture.statusCode).toBe(201);
    oldMediaId = capture.json().media[0].id;
    const row = await db.query<{ storage_key: string }>(
      `SELECT storage_key FROM moment_media WHERE id = $1`,
      [oldMediaId],
    );
    oldStorageKey = row.rows[0]!.storage_key;
    await oldApp.close();
  });

  afterAll(async () => {
    await db?.end();
  });

  it("serves old-key media, writes new-key media, during rotation", async () => {
    // Era 2: rotated config — NEW key current, OLD key in the read ring.
    const rotatedApp = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: NEW_KEY_HEX,
        NOVA_ENCRYPTION_KEYS_PREVIOUS: OLD_KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
      }),
      ocr: new CleanOcr(),
    });
    await rotatedApp.ready();
    try {
      const user = await login(rotatedApp);

      // OLD-era media serves without any re-encryption having run.
      const served = await user.inject({ method: "GET", url: `/v1/media/${oldMediaId}` });
      expect(served.statusCode).toBe(200);
      expect(served.rawPayload.subarray(1, 4).toString("latin1")).toBe("PNG");

      // New captures write with the NEW key only.
      const capture = await user.inject({
        method: "POST",
        url: "/v1/context/moments",
        payload: {
          source_mode: "instant_capture",
          source_meta: { url: "https://rotate.example.com/new", title: "New Era" },
          payload: { screenshot_data_url: await whitePng() },
          extracted_text: "new era capture",
          intent_text: null,
        },
      });
      const newKeyBlob = await readFile(
        join(
          fsRoot,
          (
            await db.query<{ storage_key: string }>(
              `SELECT storage_key FROM moment_media WHERE id = $1`,
              [capture.json().media[0].id],
            )
          ).rows[0]!.storage_key,
        ),
      );
      expect(decryptBytesWithAny([NEW_KEY], newKeyBlob)).toBeTruthy();
      expect(() => decryptBytesWithAny([OLD_KEY], newKeyBlob)).toThrow();

      // Gradual re-encryption: rotate-key --apply mid-flight, both eras
      // keep serving through the same app instance. (Exit code 2 is fine
      // here: the shared test DB carries other suites' rows encrypted with
      // their own throwaway keys, which the command rightly reports.)
      try {
        execFileSync("pnpm", ["exec", "tsx", "src/db/rotate-media-key.ts", "--apply"], {
          cwd: join(import.meta.dirname, "..", ".."),
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            NOVA_MEDIA_STORE: "fs",
            NOVA_MEDIA_FS_ROOT: fsRoot,
            NOVA_ENCRYPTION_KEY: NEW_KEY_HEX,
            NOVA_ENCRYPTION_KEY_OLD: OLD_KEY_HEX,
          },
        });
      } catch (err) {
        if ((err as { status?: number }).status !== 2) throw err;
      }
      const afterRotate = await user.inject({ method: "GET", url: `/v1/media/${oldMediaId}` });
      expect(afterRotate.statusCode).toBe(200);
      const rotatedBlob = await readFile(join(fsRoot, oldStorageKey));
      expect(decryptBytesWithAny([NEW_KEY], rotatedBlob)).toBeTruthy(); // now on new key
    } finally {
      await rotatedApp.close();
    }
  });

  it("fails safe when NO configured key can decrypt a blob", async () => {
    // An app configured with a completely unrelated key.
    const strangerApp = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        NOVA_MEDIA_FS_ROOT: fsRoot,
      }),
      ocr: null,
    });
    await strangerApp.ready();
    try {
      const user = await login(strangerApp);
      const res = await user.inject({ method: "GET", url: `/v1/media/${oldMediaId}` });
      // Undecryptable must never return bytes — a 5xx (decrypt error
      // surfaces) is acceptable; plaintext or ciphertext leakage is not.
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.rawPayload.subarray(1, 4).toString("latin1")).not.toBe("PNG");
    } finally {
      await strangerApp.close();
    }
  });
});
