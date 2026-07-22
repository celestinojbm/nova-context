import { parseEncryptionKey } from "@nova/context-engine/secret-box";
import type { OcrEngine, OcrWord } from "@nova/context-engine/visual-redaction";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { runSmoke } from "../../src/ops/smoke.js";

/**
 * M13: the post-deploy smoke suite, exercised against a REAL listening app
 * over HTTP — exactly how the operator runs `ops:smoke` after a deploy.
 * Live Q&A and worker processing report `degraded` here (no Anthropic key,
 * no worker), which is the honest post-deploy answer for such a config.
 */
const databaseUrl = process.env.DATABASE_URL;

const KEY_HEX = randomBytes(32).toString("hex");
parseEncryptionKey(KEY_HEX);

class FakeOcr implements OcrEngine {
  readonly name = "fake";
  async recognize(): Promise<{ words: OcrWord[] }> {
    return { words: [{ text: "synthetic", x0: 0, y0: 0, x1: 5, y1: 5 }] };
  }
}

describe.skipIf(!databaseUrl)("M13: ops:smoke against a live instance", () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: join(tmpdir(), `nova-smoke-${Date.now()}`),
      }),
      ocr: new FakeOcr(),
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = address;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("walks the full product surface: nothing fails, degradations are honest", async () => {
    // M18A.5 (NCA-17-002): snapshot smoke-account/session/pairing counts so we
    // can prove the run leaves NOTHING new behind in the real database.
    const db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    const counts = async () => {
      const q = async (sql: string) => (await db.query(sql)).rows[0].n as number;
      return {
        users: await q("SELECT count(*)::int AS n FROM users WHERE email LIKE '%@alpha.local'"),
        sessions: await q(
          `SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE u.email LIKE '%@alpha.local' AND s.revoked_at IS NULL`,
        ),
        pairing: await q(
          `SELECT count(*)::int AS n FROM pairing_codes p JOIN users u ON u.id = p.user_id
            WHERE u.email LIKE '%@alpha.local'`,
        ),
      };
    };
    const before = await counts();

    const { ok, steps } = await runSmoke(baseUrl, { enrichmentWaitMs: 1000 });
    const byName = Object.fromEntries(steps.map((s) => [s.step, s]));

    // The smoke account, its web + extension/device sessions, and its pairing
    // codes are all gone — the run added nothing to the real database.
    const after = await counts();
    await db.end();
    expect(after).toEqual(before);
    // No token-like secret (web/device token, password, invite) in the output.
    expect(JSON.stringify(steps)).not.toMatch(/[A-Za-z0-9_-]{40,}/);

    expect(byName["readyz"]!.status).toBe("ok");
    expect(byName["signup"]!.status).toBe("ok");
    expect(byName["login"]!.status).toBe("ok");
    expect(byName["extension_pairing"]!.status).toBe("ok");
    expect(byName["instant_capture"]!.status).toBe("ok");
    expect(byName["visual_redaction"]!.status).toBe("ok");
    expect(byName["media_storage"]!.status).toBe("ok");
    expect(byName["task_creation"]!.status).toBe("ok");
    expect(byName["timeline"]!.status).toBe("ok");
    expect(byName["search"]!.status).toBe("ok");
    // No Anthropic key in this deploy → degraded is the CORRECT answer.
    expect(byName["live_qa"]!.status).toBe("degraded");
    expect(byName["save_from_live"]!.status).toBe("ok");
    expect(byName["approval_queue"]!.status).toBe("ok");
    expect(byName["notion_status"]!.status).toBe("ok");
    expect(byName["export"]!.status).toBe("ok");
    // No worker in this suite → queued/skipped, reported as degraded.
    expect(byName["worker_processing"]!.status).toBe("degraded");
    expect(byName["delete_moment"]!.status).toBe("ok");
    expect(byName["audit_log"]!.status).toBe("ok");
    expect(byName["status_page"]!.status).toBe("ok");
    expect(byName["worker_heartbeat"]!.status).toBe("degraded");
    expect(byName["account_delete"]!.status).toBe("ok");

    expect(steps.every((s) => s.status !== "fail")).toBe(true);
    expect(ok).toBe(true);
  }, 30_000);
});
