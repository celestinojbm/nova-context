import { buildNotionPageContent } from "@nova/context-engine";
import { decryptSecret, parseEncryptionKey } from "@nova/context-engine/secret-box";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import pg from "pg";
import type { WorkerEnv } from "./env.js";
import {
  HttpNotionClient,
  NotionTransientError,
  type NotionClient,
} from "./notion-client.js";

/** Mirrors services/api/src/queue.ts — the producer side of this contract. */
export const ACTION_QUEUE = "action-execution";

export interface ActionJobData {
  actionId: string;
  userId: string;
}

export interface ActionDeps {
  notion: NotionClient;
  encryptionKey: Buffer | null;
}

export function buildActionDeps(env: WorkerEnv): ActionDeps {
  return {
    notion: new HttpNotionClient(),
    encryptionKey: env.NOVA_ENCRYPTION_KEY
      ? parseEncryptionKey(env.NOVA_ENCRYPTION_KEY)
      : null,
  };
}

async function audit(
  db: pg.Pool,
  userId: string,
  eventType: string,
  subjectId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (user_id, event_type, subject_kind, subject_id, detail)
     VALUES ($1, $2, 'action', $3, $4)`,
    [userId, eventType, subjectId, JSON.stringify(detail)],
  );
}

export async function markActionFailed(
  db: pg.Pool,
  data: ActionJobData,
  reason: string,
): Promise<void> {
  // Never clobber a completed action (late failure signal after success).
  const { rowCount } = await db.query(
    `UPDATE actions SET status = 'failed', result = $1, updated_at = now()
     WHERE id = $2 AND user_id = $3 AND status IN ('queued','executing')`,
    [JSON.stringify({ error: reason }), data.actionId, data.userId],
  );
  if (rowCount) {
    await audit(db, data.userId, "action.execute.failed", data.actionId, { reason });
  }
}

/**
 * Execute one approved external action (M6). Idempotent by construction:
 *   - only 'queued'/'executing' actions run (atomic claim);
 *   - a previously stored external id short-circuits to 'done' without a
 *     second provider call (job retry / redelivery safe);
 *   - the provider call happens once per attempt, and the external id is
 *     persisted in the same statement that completes the action.
 * Throws NotionTransientError to request a queue retry; terminal problems
 * (no connection, undecryptable token, provider 4xx) mark the action
 * 'failed' and throw UnrecoverableError so BullMQ stops early.
 */
export async function executeAction(
  db: pg.Pool,
  deps: ActionDeps,
  data: ActionJobData,
  attempt = 1,
): Promise<"done" | "skipped" | "failed"> {
  const { rows } = await db.query(
    `SELECT a.id, a.action_type, a.status, a.payload, a.result, a.moment_id,
            m.source_meta, m.summary, m.extracted_text, m.intent_text,
            m.captured_at, m.enrichment, m.redaction_state, m.image_redaction
     FROM actions a
     LEFT JOIN context_moments m ON m.id = a.moment_id
     WHERE a.id = $1 AND a.user_id = $2`,
    [data.actionId, data.userId],
  );
  const action = rows[0];
  // Unknown, someone else's, or already settled — nothing to do.
  if (!action) return "skipped";
  if (action.status === "done") return "done";
  if (action.status !== "queued" && action.status !== "executing") return "skipped";

  const terminal = async (reason: string): Promise<never> => {
    await markActionFailed(db, data, reason);
    throw new UnrecoverableError(reason);
  };

  if (action.action_type !== "notion_page") {
    return terminal(`no_worker_adapter_for_${action.action_type}`);
  }

  // A previous attempt already created the page but crashed before/while
  // finishing — finalize instead of creating a duplicate.
  const priorPageId = (action.result as { page_id?: string } | null)?.page_id;
  if (priorPageId) {
    await db.query(
      `UPDATE actions SET status = 'done', updated_at = now() WHERE id = $1`,
      [action.id],
    );
    await audit(db, data.userId, "action.execute", action.id, {
      action_type: action.action_type,
      provider: "notion",
      external_id: priorPageId,
      recovered: true,
    });
    return "done";
  }

  const claim = await db.query(
    `UPDATE actions SET status = 'executing', updated_at = now()
     WHERE id = $1 AND status IN ('queued','executing') RETURNING id`,
    [action.id],
  );
  if (!claim.rowCount) return "skipped";
  await audit(db, data.userId, "action.executing", action.id, {
    action_type: action.action_type,
    attempt,
  });

  // The connection lookup is strictly user-scoped: this job can only ever
  // execute with the token of the user who owns the action.
  const conn = await db.query<{
    token_ciphertext: Buffer;
    external_account: string | null;
    meta: Record<string, unknown>;
  }>(
    `SELECT token_ciphertext, external_account, meta FROM integration_connections
     WHERE user_id = $1 AND provider = 'notion' AND status = 'active'`,
    [data.userId],
  );
  if (!conn.rows.length) return terminal("notion_not_connected");
  if (!deps.encryptionKey) return terminal("encryption_key_missing");

  let token: string;
  try {
    token = decryptSecret(deps.encryptionKey, conn.rows[0]!.token_ciphertext);
  } catch {
    return terminal("token_decrypt_failed");
  }

  const payload = action.payload as {
    title?: string;
    detail?: string | null;
    destination?: { id: string; type: "page_id" | "database_id"; title: string } | null;
  };
  const content = buildNotionPageContent(
    { title: payload.title ?? "Nova Context page", detail: payload.detail ?? null },
    {
      momentId: action.moment_id,
      momentTitle:
        typeof action.source_meta?.title === "string" ? action.source_meta.title : null,
      momentSummary: action.summary,
      sourceUrl:
        typeof action.source_meta?.url === "string" ? action.source_meta.url : null,
      capturedAt: action.captured_at ? action.captured_at.toISOString() : null,
      extractedText: action.extracted_text,
      instruction: action.intent_text,
      tags: Array.isArray(action.enrichment?.tags) ? action.enrichment.tags : [],
      actionId: action.id,
      textRedaction: action.redaction_state ?? null,
      imageRedaction: (action.image_redaction?.state as string | undefined) ?? "none",
      imageMaskedRegions: Number(action.image_redaction?.masked ?? 0),
    },
  );

  try {
    // M7 destination resolution: approval-time override > user default >
    // most-recently-edited shared page. All three live inside the OWNER's
    // own workspace/token — never another user's.
    const savedDefault = conn.rows[0]!.meta?.default_destination as
      | { id: string; type: "page_id" | "database_id"; title: string }
      | undefined;
    const chosen = payload.destination ?? savedDefault ?? null;
    const parent = chosen
      ? { type: chosen.type, id: chosen.id, title: chosen.title }
      : await deps.notion.findParent(token);
    if (!parent) return terminal("no_accessible_notion_page");
    const page = await deps.notion.createPage(token, parent, content);
    // External id lands in the SAME statement that completes the action, so
    // any later redelivery takes the short-circuit path above.
    await db.query(
      `UPDATE actions SET status = 'done', result = $1, updated_at = now()
       WHERE id = $2`,
      [
        JSON.stringify({
          provider: "notion",
          page_id: page.id,
          page_url: page.url,
          parent_id: parent.id,
          parent_title: parent.title,
        }),
        action.id,
      ],
    );
    await audit(db, data.userId, "action.execute", action.id, {
      action_type: action.action_type,
      provider: "notion",
      external_id: page.id,
      workspace: conn.rows[0]!.external_account,
      destination_title: parent.title,
    });
    return "done";
  } catch (err) {
    if (err instanceof UnrecoverableError) throw err;
    if (err instanceof NotionTransientError) throw err; // queue retries
    return terminal(
      `notion_error: ${(err as Error).message.slice(0, 200)}`,
    );
  }
}

export interface StartActionWorkerOptions {
  env: WorkerEnv;
  pool?: pg.Pool;
  deps?: ActionDeps;
  concurrency?: number;
  queueName?: string;
}

export function startActionWorker({
  env,
  pool,
  deps,
  concurrency = 2,
  queueName,
}: StartActionWorkerOptions): Worker<ActionJobData> {
  const db = pool ?? new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
  const resolvedDeps = deps ?? buildActionDeps(env);

  const worker = new Worker<ActionJobData>(
    queueName ?? env.NOVA_ACTION_QUEUE,
    async (job: Job<ActionJobData>) => {
      await executeAction(db, resolvedDeps, job.data, job.attemptsMade + 1);
    },
    { connection: { url: env.REDIS_URL }, concurrency },
  );

  worker.on("failed", (job, err) => {
    const attempts = job?.opts.attempts ?? 1;
    const madeAll = (job?.attemptsMade ?? 0) >= attempts;
    console.error(
      `[worker] action ${job?.data.actionId} attempt ${job?.attemptsMade}/${attempts} failed: ${err.message}`,
    );
    // Transient failures retry; only the FINAL attempt marks 'failed'
    // (UnrecoverableError paths already did their own marking).
    if (job && madeAll && !(err instanceof UnrecoverableError)) {
      void markActionFailed(db, job.data, err.message.slice(0, 200)).catch((markErr) =>
        console.error("[worker] markActionFailed errored:", markErr),
      );
    }
  });
  worker.on("completed", (job) => {
    console.log(`[worker] action ${job.data.actionId} executed`);
  });

  if (!pool) {
    worker.on("closed", () => {
      void db.end();
    });
  }
  return worker;
}
