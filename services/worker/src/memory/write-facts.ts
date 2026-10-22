import type pg from "pg";
import { EXTRACTOR_ID, extractFacts } from "./fact-extractor.js";

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
  }>(
    `SELECT m.user_id, m.extracted_text, m.intent_text, m.redaction_state, m.captured_at,
            p.local_only
     FROM context_moments m LEFT JOIN projects p ON p.id = m.project_id
     WHERE m.id = $1`,
    [momentId],
  );
  const m = rows[0];
  if (!m) return { written: 0, extracted: 0, skipped: "not_found" };
  if (m.redaction_state !== "applied" && m.redaction_state !== "skipped") {
    return { written: 0, extracted: 0, skipped: "redaction_pending" };
  }
  const facts = extractFacts(m.intent_text, m.extracted_text);
  let written = 0;
  for (const f of facts) {
    const ins = await db.query<{ id: string }>(
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
        JSON.stringify({ kind: f.kind }),
        m.captured_at,
        f.content_hash,
        EXTRACTOR_ID,
        Boolean(m.local_only),
      ],
    );
    const id = ins.rows[0]?.id;
    if (!id) continue;
    written++;
    await db.query(
      `INSERT INTO memory_item_sources (memory_item_id, moment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, momentId],
    );
  }
  return { written, extracted: facts.length };
}
