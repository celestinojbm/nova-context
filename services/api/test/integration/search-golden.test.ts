import type { OcrEngine, OcrWord } from "@nova/context-engine/visual-redaction";
import type { FastifyInstance } from "fastify";
import { Jimp, JimpMime } from "jimp";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/db/migrate.js";
import { loadEnv } from "../../src/env.js";
import { createUser, type TestUser } from "./helpers.js";

/**
 * M8 search-quality pass: a small golden fixture set with expected top
 * hits, search over media-derived OCR text, and the media filters. Runs
 * FTS-only (no embedder configured) so ranking is deterministic. Every
 * fixture and query carries a per-run letters-only nonce so reruns against
 * a shared database never collide with earlier fixtures.
 */
const databaseUrl = process.env.DATABASE_URL;

// Letters-only so no fixture ever trips the digit-based redaction detectors.
const NONCE = Date.now()
  .toString()
  .replace(/\d/g, (d) => "qwertyuiop"[Number(d)]);

/** OCR engine whose word list is set per capture; nothing is sensitive-free by accident. */
class ScriptedOcr implements OcrEngine {
  readonly name = "scripted";
  words: OcrWord[] = [];
  async recognize(): Promise<{ words: OcrWord[] }> {
    return { words: this.words };
  }
}

function ocrWords(texts: string[]): OcrWord[] {
  return texts.map((text, i) => ({
    text,
    x0: i * 110,
    y0: 40,
    x1: i * 110 + 100,
    y1: 60,
  }));
}

describe.skipIf(!databaseUrl)("M8: golden search fixtures", () => {
  let app: FastifyInstance;
  let user: TestUser;
  const ocr = new ScriptedOcr();

  /** id per fixture key, so assertions read like the golden table. */
  const ids: Record<string, string> = {};

  async function seed(
    key: string,
    text: string,
    opts: { ocrTexts?: string[] } = {},
  ): Promise<void> {
    let screenshot: string | null = null;
    if (opts.ocrTexts) {
      ocr.words = ocrWords(opts.ocrTexts);
      const img = new Jimp({ width: 500, height: 120, color: 0xffffffff });
      screenshot = `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;
    }
    const res = await user.inject({
      method: "POST",
      url: "/v1/context/moments",
      payload: {
        source_mode: "instant_capture",
        source_meta: { url: `https://golden.example.com/${key}`, title: key },
        payload: screenshot ? { screenshot_data_url: screenshot } : {},
        extracted_text: text,
        intent_text: null,
      },
    });
    expect(res.statusCode).toBe(201);
    ids[key] = res.json().id;
  }

  async function search(body: Record<string, unknown>) {
    const res = await user.inject({
      method: "POST",
      url: "/v1/memory/search",
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      items: Array<{ id: string; score: number | null; match: string | null }>;
      legs: { fts: boolean; vector: boolean };
    };
  }

  beforeAll(async () => {
    await migrate(databaseUrl!);
    app = await buildApp({
      env: loadEnv({
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        NOVA_MEDIA_FS_ROOT: join(tmpdir(), `nova-search-golden-${NONCE}`),
      }),
      ocr,
    });
    await app.ready();
    user = await createUser(app, `golden-${NONCE}@test.local`);

    // The golden set: six moments, two of which carry media. Fixture "receipt"
    // has NO query words in its text — only its screenshot's OCR mentions the
    // invoice term, so finding it proves media-derived text is searchable.
    await seed("kubernetes", `${NONCE} kubernetes deployment rollout guide for staging`);
    await seed("sourdough", `${NONCE} sourdough bread recipe with high hydration`);
    await seed("budget", `${NONCE} quarterly budget spreadsheet for the finance review`);
    await seed("plain", `${NONCE} meeting notes without any media attached`);
    await seed("receipt", `${NONCE} saved page`, {
      ocrTexts: [`${NONCE}wombat`, "invoice", "total", "bob@example.com"],
    });
    await seed("dashboard", `${NONCE} metrics overview page`, {
      ocrTexts: ["latency", "dashboard", "uptime"],
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it("returns the expected top hit for each golden query", async () => {
    const golden: Array<[query: string, expected: string]> = [
      [`${NONCE} kubernetes rollout`, "kubernetes"],
      [`${NONCE} sourdough hydration`, "sourdough"],
      [`${NONCE} quarterly budget`, "budget"],
      [`${NONCE} meeting notes`, "plain"],
    ];
    for (const [query, expected] of golden) {
      const { items, legs } = await search({ query });
      expect(legs.fts).toBe(true);
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].id).toBe(ids[expected]);
    }
  });

  it("finds a moment through media-derived OCR text alone", async () => {
    // "wombat…" appears only in the screenshot's OCR output, never in
    // extracted_text — the hit proves ocr_text is part of the index.
    const { items } = await search({ query: `${NONCE}wombat invoice` });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].id).toBe(ids.receipt);
  });

  it("never indexes sensitive OCR words (masked before storage, absent from search)", async () => {
    const { items } = await search({ query: "bob@example.com" });
    expect(items.map((i) => i.id)).not.toContain(ids.receipt);
  });

  it("filters by media presence", async () => {
    const withMedia = await search({ query: NONCE, has_media: true });
    expect(withMedia.items.map((i) => i.id).sort()).toEqual(
      [ids.receipt, ids.dashboard].sort(),
    );

    const withoutMedia = await search({ query: NONCE, has_media: false });
    const withoutIds = withoutMedia.items.map((i) => i.id);
    expect(withoutIds).toContain(ids.kubernetes);
    expect(withoutIds).not.toContain(ids.receipt);
    expect(withoutIds).not.toContain(ids.dashboard);
  });

  it("filters by image redaction state", async () => {
    const applied = await search({ query: NONCE, image_redaction_state: "applied" });
    expect(applied.items.map((i) => i.id).sort()).toEqual(
      [ids.receipt, ids.dashboard].sort(),
    );
  });

  it("media filters also work without a text query (pure filter listing)", async () => {
    const { items, legs } = await search({ has_media: true });
    expect(legs.fts).toBe(false);
    const found = items.map((i) => i.id);
    expect(found).toContain(ids.receipt);
    expect(found).toContain(ids.dashboard);
    for (const item of items) {
      expect(item.id).not.toBe(ids.plain);
    }
  });
});
