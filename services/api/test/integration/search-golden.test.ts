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
    opts: { ocrTexts?: string[]; title?: string; intent?: string } = {},
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
        source_meta: { url: `https://golden.example.com/${key}`, title: opts.title ?? key },
        payload: screenshot ? { screenshot_data_url: screenshot } : {},
        extracted_text: text,
        intent_text: opts.intent ?? null,
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

    // The golden set (M8, widened in M9): ten moments, three with media.
    // Fixture "receipt" has NO query words in its text — only its
    // screenshot's OCR mentions the invoice term, so finding it proves
    // media-derived text is searchable.
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
    // M9 additions: near-duplicate topics to make top-hit ranking earn it,
    // and a media fixture whose OCR carries a sensitive number.
    await seed("kubernetes2", `${NONCE} kubernetes cost report for the platform team`);
    await seed("terraform", `${NONCE} terraform module registry conventions`);
    await seed("onboarding", `${NONCE} onboarding checklist for new engineers`);
    await seed("cardpage", `${NONCE} checkout page capture`, {
      // The card number word is masked by visual redaction (Luhn detector);
      // only the safe words may reach the index.
      ocrTexts: [`${NONCE}checkout`, "confirm", "4111111111111111"],
    });
    // M11 tuning fixtures: the same term in a TITLE (weight B) must beat
    // it buried in body text (weight C); intent (A) beats both.
    await seed("title-hit", `${NONCE} unrelated body copy`, {
      title: `${NONCE} migraine research overview`,
    });
    await seed("body-hit", `${NONCE} notes that mention migraine treatments in passing`);
    await seed("intent-hit", `${NONCE} plain body`, {
      intent: `${NONCE} remind me about the migraine appointment`,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it("returns the expected top hit for each golden query", async () => {
    const golden: Array<[query: string, expected: string]> = [
      [`${NONCE} kubernetes rollout`, "kubernetes"],
      [`${NONCE} kubernetes cost`, "kubernetes2"],
      [`${NONCE} sourdough hydration`, "sourdough"],
      [`${NONCE} quarterly budget`, "budget"],
      [`${NONCE} meeting notes`, "plain"],
      [`${NONCE} terraform module`, "terraform"],
      [`${NONCE} onboarding checklist`, "onboarding"],
    ];
    for (const [query, expected] of golden) {
      const { items, legs } = await search({ query });
      expect(legs.fts).toBe(true);
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].id).toBe(ids[expected]);
    }
  });

  it("M9: partial words match through the prefix fallback", async () => {
    // "deplo" matches no whole lexeme ("deployment" indexes as "deploy"),
    // so the whole-word pass is empty and the prefix pass
    // (kubernet:* & deplo:*) takes over.
    const { items, legs } = await search({
      query: `${NONCE} kubernet deplo`,
      debug: true,
    });
    expect(legs.prefix_fallback).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].id).toBe(ids.kubernetes);
    expect(items[0].diagnostics.prefix_fallback).toBe(true);

    // Whole-word matches never take the fallback path.
    const exact = await search({ query: `${NONCE} sourdough`, debug: true });
    expect(exact.legs.prefix_fallback).toBe(false);
    expect(exact.items[0].diagnostics.prefix_fallback).toBe(false);
  });

  it("M9: partial OCR-derived terms are retrievable too", async () => {
    const { items, legs } = await search({ query: `${NONCE}womb` });
    expect(legs.prefix_fallback).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].id).toBe(ids.receipt);
  });

  it("M9: ranking diagnostics expose raw leg scores only when asked", async () => {
    const withDebug = await search({ query: `${NONCE} kubernetes rollout`, debug: true });
    expect(withDebug.items[0].diagnostics).toBeTruthy();
    expect(withDebug.items[0].diagnostics.fts_rank).toBeGreaterThan(0);
    expect(withDebug.items[0].diagnostics.vector_similarity).toBeNull(); // no embedder

    const without = await search({ query: `${NONCE} kubernetes rollout` });
    expect(without.items[0].diagnostics).toBeUndefined();
  });

  it("M11: field weights rank intent over title over body for the same term", async () => {
    const { items } = await search({ query: `${NONCE} migraine`, debug: true });
    const order = items.map((i) => i.id);
    expect(order.indexOf(ids.intent!)).toBe(-1); // sanity: no such key
    const intentPos = order.indexOf(ids["intent-hit"]!);
    const titlePos = order.indexOf(ids["title-hit"]!);
    const bodyPos = order.indexOf(ids["body-hit"]!);
    expect(intentPos).toBeGreaterThanOrEqual(0);
    expect(titlePos).toBeGreaterThanOrEqual(0);
    expect(bodyPos).toBeGreaterThanOrEqual(0);
    // A (intent) > B (title) > C (body) — the tuning contract, pinned.
    expect(intentPos).toBeLessThan(titlePos);
    expect(titlePos).toBeLessThan(bodyPos);
    // Diagnostics expose the raw ranks that justify the order.
    expect(items[intentPos]!.diagnostics.fts_rank).toBeGreaterThan(
      items[bodyPos]!.diagnostics.fts_rank,
    );
  });

  it("M9: masked sensitive OCR values are unreachable — even via prefix", async () => {
    // The card number was masked before storage, so neither the full value
    // nor a prefix of it can ever come back.
    for (const q of ["4111111111111111", "4111111111"]) {
      const { items } = await search({ query: q });
      expect(items.map((i) => i.id)).not.toContain(ids.cardpage);
    }
    // The safe OCR words on the same image ARE findable.
    const safe = await search({ query: `${NONCE}checkout confirm` });
    expect(safe.items.map((i) => i.id)).toContain(ids.cardpage);
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
      [ids.receipt, ids.dashboard, ids.cardpage].sort(),
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
      [ids.receipt, ids.dashboard, ids.cardpage].sort(),
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
