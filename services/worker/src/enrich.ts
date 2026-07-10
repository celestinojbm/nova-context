import {
  localEnrichmentDraft,
  suggestProjects,
} from "@nova/context-engine";
import type {
  AnthropicEnricher,
  EmbeddingProvider,
} from "@nova/model-router";
import type {
  EnrichmentDraft,
  EnrichmentResult,
  ParsedIntent,
} from "@nova/schema";
import type pg from "pg";

/**
 * Enrichment pipeline (M2). Status transitions on context_moments:
 *   pending → processing → completed | failed (final attempt only)
 * Writes: summary, entities (+mentions), enrichment jsonb (tags, priority,
 * candidates, project candidates), refined intent, proposed actions rows,
 * and an embedding when a provider is configured. Every leg degrades: no
 * LLM → local heuristics; no embedder → no vector, still 'completed'.
 */

export interface EnrichDeps {
  enricher: AnthropicEnricher | null;
  embedder: EmbeddingProvider | null;
  /** 'local' stores product events; 'off' drops them (M4 analytics). */
  analytics?: "local" | "off";
}

function trackEvent(
  db: pg.Pool,
  deps: EnrichDeps,
  userId: string,
  event: string,
  props: Record<string, unknown>,
): void {
  if (deps.analytics === "off") return;
  void db
    .query(`INSERT INTO product_events (user_id, event, props) VALUES ($1, $2, $3)`, [
      userId,
      event,
      JSON.stringify(props),
    ])
    .catch(() => {/* analytics never break enrichment */});
}

interface MomentForEnrichment {
  id: string;
  user_id: string;
  project_id: string | null;
  source_meta: Record<string, unknown>;
  extracted_text: string | null;
  intent_text: string | null;
  intent_parsed: ParsedIntent | null;
}

export async function markProcessing(db: pg.Pool, momentId: string): Promise<void> {
  await db.query(
    `UPDATE context_moments SET enrichment_status = 'processing' WHERE id = $1`,
    [momentId],
  );
}

export async function markFailed(
  db: pg.Pool,
  momentId: string,
  userId: string,
  error: string,
): Promise<void> {
  await db.query(
    `UPDATE context_moments
     SET enrichment_status = 'failed', enrichment_error = $2
     WHERE id = $1`,
    [momentId, error.slice(0, 1000)],
  );
  await db.query(
    `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
     VALUES ($1, 'enrichment.failed', 'moment', $2, $3)`,
    [userId, momentId, JSON.stringify({ error: error.slice(0, 300) })],
  );
  void db
    .query(`INSERT INTO product_events (user_id, event, props) VALUES ($1, 'enrichment_failed', '{}')`, [userId])
    .catch(() => {/* analytics never break failure marking */});
}

export async function enrichMoment(
  db: pg.Pool,
  deps: EnrichDeps,
  momentId: string,
): Promise<EnrichmentResult> {
  const { rows } = await db.query<MomentForEnrichment>(
    `SELECT id, user_id, project_id, source_meta, extracted_text, intent_text, intent_parsed
     FROM context_moments WHERE id = $1`,
    [momentId],
  );
  const moment = rows[0];
  if (!moment) throw new Error(`moment ${momentId} not found`);

  await markProcessing(db, momentId);

  const hasTask =
    (await db.query("SELECT 1 FROM tasks WHERE moment_id = $1 LIMIT 1", [momentId]))
      .rowCount! > 0;

  const localInput = {
    extractedText: moment.extracted_text,
    intentText: moment.intent_text,
    intent: moment.intent_parsed,
    sourceMeta: moment.source_meta,
    hasTask,
  };

  // 1. Draft: LLM when configured, local heuristics as draft-of-record
  //    otherwise or on LLM failure.
  let draft: EnrichmentDraft;
  if (deps.enricher) {
    try {
      draft = await deps.enricher.enrich({
        title: (moment.source_meta["title"] as string | undefined) ?? null,
        url: (moment.source_meta["url"] as string | undefined) ?? null,
        extractedText: moment.extracted_text,
        intentText: moment.intent_text,
      });
    } catch {
      draft = localEnrichmentDraft(localInput);
    }
  } else {
    draft = localEnrichmentDraft(localInput);
  }

  // 2. Refine the stored intent when the LLM reclassified it. The heuristic
  //    parse from capture time is kept otherwise (never degrade stored data).
  if (
    draft.provider === "llm" &&
    draft.refined_action_type &&
    moment.intent_parsed &&
    draft.refined_action_type !== moment.intent_parsed.action_type
  ) {
    const refined: ParsedIntent = {
      ...moment.intent_parsed,
      action_type: draft.refined_action_type,
      priority_guess: draft.priority_signal,
      parser: "llm",
      model: draft.model,
    };
    await db.query(`UPDATE context_moments SET intent_parsed = $1 WHERE id = $2`, [
      JSON.stringify(refined),
      momentId,
    ]);
  }

  // 3. Entities: upsert + mention edges.
  for (const entity of draft.entities) {
    const normalized = entity.name.toLowerCase().trim();
    if (!normalized) continue;
    const entityRow = await db.query<{ id: string }>(
      `INSERT INTO entities (user_id, kind, name, normalized)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, kind, normalized) DO UPDATE SET name = entities.name
       RETURNING id`,
      [moment.user_id, entity.kind, entity.name, normalized],
    );
    await db.query(
      `INSERT INTO entity_mentions (moment_id, entity_id, confidence)
       VALUES ($1, $2, $3)
       ON CONFLICT (moment_id, entity_id) DO NOTHING`,
      [momentId, entityRow.rows[0]!.id, draft.provider === "llm" ? 0.8 : 0.5],
    );
  }

  // 4. Action candidates → proposed actions (approval queue). Model-suggested
  //    work is NEVER auto-executed regardless of tier (docs/ACTION_ENGINE.md);
  //    a human approves it in the web app. Deduped per moment+title.
  for (const candidate of draft.action_candidates) {
    await db.query(
      `INSERT INTO actions (user_id, moment_id, project_id, action_type, risk_tier, status, payload)
       SELECT $1, $2, $3, $4, $5, 'proposed', $6
       WHERE NOT EXISTS (
         SELECT 1 FROM actions
         WHERE moment_id = $2 AND action_type = $4 AND payload->>'title' = $7
       )`,
      [
        moment.user_id,
        momentId,
        moment.project_id,
        candidate.action_type,
        candidate.risk_tier,
        JSON.stringify({
          title: candidate.title,
          detail: candidate.detail,
          priority: draft.priority_signal,
          proposed_by: draft.provider,
        }),
        candidate.title,
      ],
    );
  }

  if (draft.action_candidates.length > 0) {
    trackEvent(db, deps, moment.user_id, "action_proposed", {
      count: draft.action_candidates.length,
      provider: draft.provider,
    });
  }

  // 5. Project candidates (rule scoring shared with the API).
  const projectCandidates = await suggestProjects(db, moment.user_id, {
    projectHint: moment.intent_parsed?.project_hint ?? null,
    url: (moment.source_meta["url"] as string | undefined) ?? null,
  });

  // 6. Embedding (optional). One vector per moment; replaces prior versions.
  let embedded = false;
  if (deps.embedder) {
    const embedText = [
      moment.source_meta["title"],
      draft.summary,
      moment.intent_text,
      (moment.extracted_text ?? "").slice(0, 8000),
    ]
      .filter(Boolean)
      .join("\n");
    const vector = await deps.embedder.embed(embedText);
    await db.query(
      `DELETE FROM embeddings WHERE owner_kind = 'moment' AND owner_id = $1`,
      [momentId],
    );
    await db.query(
      `INSERT INTO embeddings (user_id, owner_kind, owner_id, model, embedding)
       VALUES ($1, 'moment', $2, $3, $4::vector)`,
      [moment.user_id, momentId, deps.embedder.model, `[${vector.join(",")}]`],
    );
    embedded = true;
  }

  // 7. Finalize.
  const result: EnrichmentResult = {
    tags: draft.tags,
    priority_signal: draft.priority_signal,
    action_candidates: draft.action_candidates,
    project_candidates: projectCandidates.map((p) => ({
      id: p.id,
      name: p.name,
      confidence: p.confidence,
    })),
    provider: draft.provider,
    model: draft.model,
    embedded,
  };
  // M10 enrichment versioning: history is never overwritten. Every run
  // appends an immutable version row (provider/model/created_at); the
  // moment's summary/enrichment columns stay the CURRENT pointer, which
  // the API can move to any recorded version. Version content is derived
  // from already-redacted moment data — nothing unredacted can enter here.
  await db.query(
    `INSERT INTO enrichment_versions (moment_id, user_id, version, summary, enrichment, provider, model)
     SELECT $1, $2,
            coalesce((SELECT max(version) FROM enrichment_versions WHERE moment_id = $1), 0) + 1,
            $3, $4, $5, $6`,
    [momentId, moment.user_id, draft.summary, JSON.stringify(result), draft.provider, draft.model ?? null],
  );
  await db.query(
    `UPDATE context_moments
     SET summary = $1, enrichment = $2, enrichment_status = 'completed',
         enrichment_error = NULL, enriched_at = now()
     WHERE id = $3`,
    [draft.summary, JSON.stringify(result), momentId],
  );
  await db.query(
    `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
     VALUES ($1, 'enrichment.completed', 'moment', $2, $3)`,
    [
      moment.user_id,
      momentId,
      JSON.stringify({
        provider: draft.provider,
        embedded,
        entities: draft.entities.length,
        candidates: draft.action_candidates.length,
      }),
    ],
  );
  return result;
}
