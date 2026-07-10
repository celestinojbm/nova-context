import type pg from "pg";

/**
 * M13 alpha usage report — the real-world feedback loop, aggregated.
 * Counts and short categories ONLY: product events are allowlisted names
 * with content-free props, failure reasons are trimmed classes, feedback
 * is user-authored (never captured page content) and excerpted. Nothing
 * here can contain captured content because nothing upstream stores it
 * in these tables.
 */

export interface AlphaReport {
  window_days: number;
  events: Record<string, number>;
  friction: {
    captures_failed: number;
    enrichments_failed: number;
    transcriptions_failed: number;
    failed_actions: number;
    recent_failed_actions: Array<{ id: string; reason: string; at: string }>;
  };
  usage: {
    users: number;
    moments: number;
    tasks: number;
    enrichment_versions_by_provider: Record<string, number>;
    live_questions: number;
    media_objects: number;
    media_bytes: number;
    pending_media_deletes: number;
  };
  feedback: Array<{
    id: string;
    category: string;
    status: string;
    created_at: string;
    excerpt: string;
  }>;
  warnings: string[];
  generated_at: string;
}

export async function runAlphaReport(
  db: pg.Pool | pg.Client,
  opts: { days?: number; mediaWarnMb?: number } = {},
): Promise<AlphaReport> {
  const days = opts.days ?? 14;
  const mediaWarnMb = opts.mediaWarnMb ?? 1024;

  const events = await db.query<{ event: string; n: string }>(
    `SELECT event, count(*) AS n FROM product_events
     WHERE created_at > now() - ($1 || ' days')::interval
     GROUP BY event ORDER BY n DESC`,
    [days],
  );
  const eventCounts = Object.fromEntries(events.rows.map((r) => [r.event, Number(r.n)]));

  const failedActions = await db.query<{ id: string; result: { error?: string } | null; updated_at: Date }>(
    `SELECT id, result, updated_at FROM actions WHERE status = 'failed'
     ORDER BY updated_at DESC LIMIT 5`,
  );
  const failedActionCount = await db.query(
    `SELECT count(*) AS n FROM actions WHERE status = 'failed'`,
  );

  const totals = await db.query<{ users: string; moments: string; tasks: string }>(
    `SELECT (SELECT count(*) FROM users) AS users,
            (SELECT count(*) FROM context_moments) AS moments,
            (SELECT count(*) FROM tasks) AS tasks`,
  );
  const media = await db.query<{ objects: string; bytes: string }>(
    `SELECT count(*) AS objects,
            coalesce(sum(bytes),0) + coalesce(sum(thumb_bytes),0) AS bytes
     FROM moment_media`,
  );
  const pendingDeletes = await db.query(`SELECT count(*) AS n FROM media_delete_queue`);
  const providers = await db.query<{ provider: string; n: string }>(
    `SELECT provider, count(*) AS n FROM enrichment_versions GROUP BY provider`,
  );
  const feedback = await db.query<{
    id: string;
    category: string;
    status: string;
    created_at: Date;
    message: string;
  }>(
    `SELECT id, category, status, created_at, message FROM alpha_feedback
     ORDER BY created_at DESC LIMIT 20`,
  );

  const mediaBytes = Number(media.rows[0]!.bytes);
  const pending = Number(pendingDeletes.rows[0]!.n);
  const failed = Number(failedActionCount.rows[0]!.n);

  const warnings: string[] = [];
  if (mediaBytes > mediaWarnMb * 1024 * 1024) {
    warnings.push(`media storage above ${mediaWarnMb}MB threshold`);
  }
  if (pending > 0) warnings.push(`${pending} pending media delete(s) — run media:cleanup -- --delete`);
  if (failed > 0) warnings.push(`${failed} failed action(s) — see recent_failed_actions`);
  if ((eventCounts["capture_failed"] ?? 0) > 0) {
    warnings.push(`${eventCounts["capture_failed"]} failed capture(s) in the last ${days}d`);
  }
  const newFeedback = feedback.rows.filter((f) => f.status === "new").length;
  if (newFeedback > 0) warnings.push(`${newFeedback} untriaged feedback item(s)`);

  return {
    window_days: days,
    events: eventCounts,
    friction: {
      captures_failed: eventCounts["capture_failed"] ?? 0,
      enrichments_failed: eventCounts["enrichment_failed"] ?? 0,
      transcriptions_failed: eventCounts["transcription_failed"] ?? 0,
      failed_actions: failed,
      recent_failed_actions: failedActions.rows.map((r) => ({
        id: r.id,
        reason: (r.result?.error ?? "unknown").slice(0, 120),
        at: r.updated_at.toISOString(),
      })),
    },
    usage: {
      users: Number(totals.rows[0]!.users),
      moments: Number(totals.rows[0]!.moments),
      tasks: Number(totals.rows[0]!.tasks),
      enrichment_versions_by_provider: Object.fromEntries(
        providers.rows.map((r) => [r.provider, Number(r.n)]),
      ),
      live_questions: eventCounts["live_question_asked"] ?? 0,
      media_objects: Number(media.rows[0]!.objects),
      media_bytes: mediaBytes,
      pending_media_deletes: pending,
    },
    feedback: feedback.rows.map((f) => ({
      id: f.id,
      category: f.category,
      status: f.status,
      created_at: f.created_at.toISOString(),
      excerpt: f.message.replace(/\s+/g, " ").slice(0, 160),
    })),
    warnings,
    generated_at: new Date().toISOString(),
  };
}
