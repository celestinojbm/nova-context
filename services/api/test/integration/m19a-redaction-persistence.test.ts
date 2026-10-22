import { decryptBytes, parseEncryptionKey } from "@nova/context-engine/secret-box";
import {
  MIN_ANALYSIS_HEIGHT,
  MIN_ANALYSIS_WIDTH,
  type OcrEngine,
  type OcrWord,
} from "@nova/context-engine/visual-redaction";
import type { FastifyInstance } from "fastify";
import { Jimp, JimpMime } from "jimp";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M19A (Hermes D-10) — end-to-end proof that the honest redaction state
 * survives the WHOLE capture path: OCR gate → payload → media pipeline →
 * object store → API responses → search → audit log.
 *
 * The defect being pinned: a capture downscaled below the analysis floor
 * used to be persisted with `redaction_state: 'applied'` while its pixels
 * were still legible. The tests below assert the three things that had to
 * become simultaneously true:
 *
 *   1. no artifact we could not certify is ever WRITTEN (row or blob);
 *   2. the state reported to every reader is the honest one; and
 *   3. media stored under the old rules keeps working (no silent breakage
 *      of already-captured user data).
 *
 * SYNTHETIC DATA ONLY — a reserved example address on a generated canvas.
 */
const databaseUrl = process.env.DATABASE_URL;

const KEY_HEX = randomBytes(32).toString("hex");
const KEY = parseEncryptionKey(KEY_HEX);
const SECRET = "alice@synthetic.test";
const SECRET_BOX = { x0: 200, y0: 200, x1: 520, y1: 240 };

/** Reports the planted secret wherever it is asked — so any difference in
 * outcome comes from the COVERAGE gate, never from OCR luck. */
class ScriptedOcr implements OcrEngine {
  readonly name = "scripted";
  calls = 0;
  async recognize(): Promise<{ words: OcrWord[] }> {
    this.calls += 1;
    return {
      words: [
        { text: "roadmap", x0: 10, y0: 10, x1: 120, y1: 40 },
        { text: SECRET, ...SECRET_BOX },
      ],
    };
  }
}

async function canvas(w: number, h: number): Promise<string> {
  const img = new Jimp({ width: w, height: h, color: 0xffffffff });
  return `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;
}
/** Above the M19A analysis floor — certifiable. */
const certifiable = () => canvas(MIN_ANALYSIS_WIDTH, MIN_ANALYSIS_HEIGHT);
/** The exact shape the pre-M19A extension produced: 800px wide. */
const downscaled = () => canvas(800, 450);

function body(screenshot: string, extra: Record<string, unknown> = {}) {
  return {
    source_mode: "instant_capture",
    source_meta: { url: "https://m19a.example.com/page", title: "M19A" },
    payload: { screenshot_data_url: screenshot },
    extracted_text: "m19a persistence",
    intent_text: null,
    ...extra,
  };
}

async function allBlobs(root: string): Promise<Buffer[]> {
  const out: Buffer[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(await readFile(p));
    }
  };
  await walk(root);
  return out;
}

describe.skipIf(!databaseUrl)("M19A: honest redaction state end to end (D-10)", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let user: TestUser;
  let fsRoot: string;
  const ocr = new ScriptedOcr();

  beforeAll(async () => {
    await migrate(databaseUrl!);
    fsRoot = join(tmpdir(), `nova-m19a-${Date.now()}`);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_FS_ROOT: fsRoot,
      }),
      ocr,
    });
    await app.ready();
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    user = await createUser(app, `m19a-${Date.now()}@test.local`);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  const capture = async (screenshot: string, extra: Record<string, unknown> = {}) => {
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: body(screenshot, extra),
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  };
  /** `strict_image_redaction` defaults to TRUE in the request schema, so the
   * default server behaviour for an uncertifiable image is to DROP it. The
   * 'coverage_insufficient' state is only reachable when a client explicitly
   * opts out of strict mode — these helpers make that distinction explicit
   * instead of relying on a default. */
  const captureLenient = (screenshot: string) =>
    capture(screenshot, { strict_image_redaction: false });

  it("certifiable capture: 'applied', media row written, blob encrypted AND masked", async () => {
    const created = await capture(await certifiable());
    expect(created.image_redaction.state).toBe("applied");
    expect(created.image_redaction.masked).toBe(1);
    expect(created.media).toHaveLength(1);

    const { rows } = await db.query(
      "SELECT storage_key, redaction_state FROM moment_media WHERE moment_id = $1",
      [created.id],
    );
    expect(rows[0].redaction_state).toBe("applied");
    const blob = await readFile(join(fsRoot, rows[0].storage_key));
    expect(blob.toString("latin1")).not.toContain("IHDR"); // encrypted at rest
    const img = await Jimp.fromBuffer(decryptBytes(KEY, blob));
    expect(img.getPixelColor(300, 220)).toBe(0x000000ff); // the box is black
  });

  it("NON-STRICT below the floor: 'coverage_insufficient' and NOTHING is persisted", async () => {
    const before = (await allBlobs(fsRoot)).length;
    const created = await captureLenient(await downscaled());

    expect(created.image_redaction.state).toBe("coverage_insufficient");
    expect(created.image_redaction.masked).toBe(0); // no counts invented
    expect(created.media).toHaveLength(0);

    // No moment_media row: MediaService refuses an unsafe state.
    const media = await db.query("SELECT 1 FROM moment_media WHERE moment_id = $1", [created.id]);
    expect(media.rowCount).toBe(0);
    // No new blob on disk — the unscanned original does not survive anywhere.
    expect((await allBlobs(fsRoot)).length).toBe(before);
    // …and it is not hiding inline in the stored payload either.
    const { rows } = await db.query(
      "SELECT payload, ocr_text FROM context_moments WHERE id = $1",
      [created.id],
    );
    expect(JSON.stringify(rows[0].payload)).not.toContain("data:image");
    expect(rows[0].ocr_text).toBeNull(); // never index text we could not trust
  });

  it("STRICT (the DEFAULT) below the floor: 'blocked_strict', image dropped before the media pipeline", async () => {
    // No flag sent — the schema default is strict, so the safe outcome is
    // what a client gets without asking for it.
    const created = await capture(await downscaled());
    expect(created.image_redaction.state).toBe("blocked_strict");
    expect(created.media).toHaveLength(0);
    const { rows } = await db.query("SELECT payload FROM context_moments WHERE id = $1", [
      created.id,
    ]);
    expect(JSON.stringify(rows[0].payload)).not.toContain("data:image");
  });

  it("the uncertified state is serialized honestly on EVERY read path", async () => {
    const created = await captureLenient(await downscaled());

    const detail = await user.inject({ method: "GET", url: `/v1/context/moments/${created.id}` });
    expect(detail.json().image_redaction.state).toBe("coverage_insufficient");

    const list = await user.inject({ method: "GET", url: "/v1/context/moments?limit=50" });
    const item = list.json().items.find((m: { id: string }) => m.id === created.id);
    expect(item.image_redaction.state).toBe("coverage_insufficient");

    // Search can filter on it — an operator auditing lost guarantees needs this.
    const search = await user.inject({
      method: "POST",
      url: "/v1/memory/search",
      payload: { image_redaction_state: "coverage_insufficient", limit: 50 },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().items.some((m: { id: string }) => m.id === created.id)).toBe(true);

    // …and it is NOT returned when asking for the certified ones.
    const applied = await user.inject({
      method: "POST",
      url: "/v1/memory/search",
      payload: { image_redaction_state: "applied", limit: 50 },
    });
    expect(applied.json().items.some((m: { id: string }) => m.id === created.id)).toBe(false);
  });

  it("the audit log records the honest state, with no pixels and no secret", async () => {
    const created = await captureLenient(await downscaled());
    const { rows } = await db.query(
      `SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'capture'`,
      [created.id],
    );
    const detail = rows[0].detail as Record<string, unknown>;
    expect(detail.image_redaction).toBe("coverage_insufficient");
    expect(detail.media_stored).toBe(0);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain(SECRET);
  });

  it("export carries the moment but NEVER its uncertified pixels", async () => {
    // The export deliberately inlines `data_url` for media that IS safe —
    // that is the user's own certified data and must keep flowing. What must
    // never appear is an uncertified image.
    const created = await captureLenient(await downscaled());
    const res = await user.inject({ method: "GET", url: "/v1/export" });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as {
      moments: Array<{
        id: string;
        image_redaction: { state: string };
        media: Array<{ data_url: string | null }>;
      }>;
    };
    const mine = doc.moments.find((m) => m.id === created.id)!;
    expect(mine).toBeDefined();
    expect(mine.image_redaction.state).toBe("coverage_insufficient");
    expect(mine.media).toEqual([]); // nothing was ever stored to export
    // Every media entry anywhere in the export that carries pixels is certified.
    for (const moment of doc.moments) {
      for (const m of moment.media) {
        if (m.data_url) expect(moment.image_redaction.state).toBe("applied");
      }
    }
  });

  it("BACKWARD COMPATIBILITY: media stored before M19A still reads and exports", async () => {
    // A pre-M19A capture: certifiable, stored 'applied'. It must keep working
    // exactly as it did — M19A changes what we ACCEPT, never what we already
    // promised about data the user already has.
    const legacy = await capture(await certifiable());
    const mediaId = legacy.media[0].id;

    const full = await user.inject({ method: "GET", url: `/v1/media/${mediaId}` });
    expect(full.statusCode).toBe(200);
    const thumb = await user.inject({ method: "GET", url: `/v1/media/${mediaId}?variant=thumb` });
    expect(thumb.statusCode).toBe(200);

    // A legacy row whose dimensions are BELOW today's floor keeps its
    // 'applied' state and stays readable — the floor gates new analysis, it
    // does not retroactively invalidate stored media.
    await db.query("UPDATE moment_media SET width = 800, height = 450 WHERE id = $1", [mediaId]);
    const stillOk = await user.inject({ method: "GET", url: `/v1/media/${mediaId}` });
    expect(stillOk.statusCode).toBe(200);

    // Adapter gate: unchanged for 'applied'.
    const gate = await db.query("SELECT redaction_state FROM moment_media WHERE id = $1", [
      mediaId,
    ]);
    expect(gate.rows[0].redaction_state).toBe("applied");
  });

  it("a hand-written 'coverage_insufficient' media row is refused by every read gate", async () => {
    // Defence in depth: even if a row somehow reached this state (a future
    // writer, a bad migration), reads must fail closed rather than serve it.
    const seed = await capture(await certifiable());
    const mediaId = seed.media[0].id;
    await db.query("UPDATE moment_media SET redaction_state = 'coverage_insufficient' WHERE id = $1", [
      mediaId,
    ]);
    const res = await user.inject({ method: "GET", url: `/v1/media/${mediaId}` });
    expect(res.statusCode).toBe(404);
    const thumb = await user.inject({ method: "GET", url: `/v1/media/${mediaId}?variant=thumb` });
    expect(thumb.statusCode).toBe(404);

    // The export lists the row but withholds the pixels, with the reason.
    const doc = (await user.inject({ method: "GET", url: "/v1/export" })).json() as {
      moments: Array<{ media: Array<{ id: string; data_url: string | null; excluded_reason?: string }> }>;
    };
    const entry = doc.moments
      .flatMap((m) => m.media)
      .find((m) => m.id === mediaId)!;
    expect(entry.data_url).toBeNull();
    expect(entry.excluded_reason).toBe("redaction_not_applied");
  });

  it("no temp file or stray plaintext image is left behind by an uncertified capture", async () => {
    const before = new Set(await readdir(tmpdir()).catch(() => []));
    await captureLenient(await downscaled());
    const after = await readdir(tmpdir()).catch(() => []);
    const created = after.filter((f) => !before.has(f) && /nova|redact|ocr/i.test(f));
    expect(created).toEqual([]);
    // And every blob under the media root is still ciphertext.
    for (const blob of await allBlobs(fsRoot)) {
      expect(blob.toString("latin1")).not.toContain("IHDR");
      expect(blob.toString("latin1")).not.toContain(SECRET);
    }
  });

  it("a foreign moment id is never reachable, whatever its redaction state", async () => {
    const mine = await capture(await certifiable());
    const bob = await createUser(app, `m19a-bob-${randomUUID().slice(0, 8)}@test.local`);
    const cross = await bob.inject({ method: "GET", url: `/v1/media/${mine.media[0].id}` });
    expect(cross.statusCode).toBe(404);
  });
});
