import type pg from "pg";
import { redactText } from "@nova/context-engine";
import { EXTRACTOR_ID, extractFacts } from "./fact-extractor.js";

/**
 * PII filter for moments captured with redaction 'skipped' (review #25, pt 3):
 * the capture-time detectors (email, phone, card w/ Luhn, api_key, ssn, iban)
 * run before extraction. Detected values become [REDACTED:type] markers, so
 * the extractor drops those sentences entirely: no PII is copied to memory.
 */
export function filterSkippedPii(text: string | null): string | null {
  return text == null ? text : redactText(text).text;
}

/**
 * M20a: persist heuristic facts for one Context Moment into memory_items
 * (layer='semantic', author='model', status='active') + memory_item_sources.
 *
 * Privacy rules (docs/design/memoria-m20.md §1.4):
 *  - redaction_state must be 'applied' or 'skipped'; 'pending' (or anything
 *    unknown) is never read → returns { skipped: 'redaction_pending' }.
 *  - project local_only is inherited on every fact (memory_items.local_only)
 *    so later sync/export (M20b) can exclude them. Extraction itself is always
 *    local, so local_only content never leaves the box here.
 *  - Idempotent: unique (moment_id, content_hash).
 */

export interface WriteFactsResult {
  written: number;
  extracted: number;
  skipped?: "redaction_pending" | "not_found";
}

export async function writeMomentFacts(db: pg.Pool, momentId: string): Promise<WriteFactsResult> {
  const { rows } = await db.query<{
    user_id: string;
    extracted_text: string | null;
    intent_text: string | null;
    redaction_state: string;
    captured_at: Date | null;
    local_only: boolean | null;
    source_mode: string | null;
  }>(
    `SELECT m.user_id, m.extracted_text, m.intent_text, m.redaction_state, m.captured_at,
            m.source_mode, p.local_only
     FROM context_moments m LEFT JOIN projects p ON p.id = m.project_id
     WHERE m.id = $1`,
    [momentId],
  );
  const m = rows[0];
  if (!m) return { written: 0, extracted: 0, skipped: "not_found" };
  if (m.redaction_state !== "applied" && m.redaction_state !== "skipped") {
    return { written: 0, extracted: 0, skipped: "redaction_pending" };
  }
  const skipped = m.redaction_state === "skipped";
  const facts = extractFacts(
    skipped ? filterSkippedPii(m.intent_text) : m.intent_text,
    skipped ? filterSkippedPii(m.extracted_text) : m.extracted_text,
  );
  let written = 0;
  // One transaction for the whole fact set: a memory_item never exists
  // without its memory_item_sources row (review #25, point 2).
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const f of facts) {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO memory_items
           (user_id, moment_id, layer, content, metadata, status, valid_from, author, content_hash, extractor, local_only)
         VALUES ($1, $2, 'semantic', $3, $4, 'active', $5, 'model', $6, $7, $8)
         ON CONFLICT (moment_id, content_hash) WHERE moment_id IS NOT NULL AND content_hash IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          m.user_id,
          momentId,
          f.content,
          JSON.stringify({
            kind: f.kind,
            // Provenance + trust (review #25, points 3/4): facts are DATA,
            // never instructions. LLM consumers must use renderFactsAsData().
            trust: "untrusted",
            redaction_state: m.redaction_state,
            source_mode: m.source_mode,
            instruction_like: f.instruction_like,
          }),
          m.captured_at,
          f.content_hash,
          EXTRACTOR_ID,
          Boolean(m.local_only),
        ],
      );
      const id = ins.rows[0]?.id;
      if (!id) continue;
      written++;
      await client.query(
        `INSERT INTO memory_item_sources (memory_item_id, moment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, momentId],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    written = 0;
    throw err;
  } finally {
    client.release();
  }
  return { written, extracted: facts.length };
}
