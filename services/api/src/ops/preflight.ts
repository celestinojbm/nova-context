import { parseEncryptionKey, parseKeyList } from "@nova/context-engine/secret-box";
import pg from "pg";
import { pendingMigrations } from "../db/migrate.js";
import { loadEnv, type Env } from "../env.js";
import { storeFromEnv } from "../media/object-store.js";
import { probeStore } from "../routes-ops.js";

/**
 * M13 production preflight — everything an operator should know BEFORE a
 * deploy takes traffic, as named pass/fail checks. Complements the boot
 * validation in env.ts (which crashes on fatal config) by also probing the
 * things env parsing can't see: database/Redis/object-store connectivity,
 * key material validity, pending migrations, and policy foot-guns that are
 * technically-valid-but-unsafe configuration.
 *
 * Prints NOTHING secret: check names, booleans, and short error classes.
 */

export interface PreflightCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
}

export interface PreflightReport {
  ok: boolean;
  production: boolean;
  checks: PreflightCheck[];
}

export async function runPreflight(
  source: NodeJS.ProcessEnv = process.env,
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  const add = (name: string, status: PreflightCheck["status"], detail?: string) =>
    checks.push({ name, status, ...(detail ? { detail } : {}) });

  // 1. Env parses under the same rules the API boots with (incl. all
  // fail-closed production rules: encryption key, s3 completeness, https
  // redirect, unsafe-redaction acknowledgement).
  let env: Env;
  try {
    env = loadEnv(source);
    add("env", "ok");
  } catch (err) {
    return {
      ok: false,
      production: source.NODE_ENV === "production",
      checks: [{ name: "env", status: "fail", detail: (err as Error).message.slice(0, 300) }],
    };
  }

  // 2. Key material actually parses (not just "is set").
  if (env.NOVA_ENCRYPTION_KEY) {
    try {
      parseEncryptionKey(env.NOVA_ENCRYPTION_KEY);
      add("encryption_key", "ok");
    } catch (err) {
      add("encryption_key", "fail", (err as Error).message.slice(0, 200));
    }
  } else {
    add("encryption_key", env.isProduction ? "fail" : "warn", "not set — media + integrations disabled");
  }
  if (env.NOVA_ENCRYPTION_KEYS_PREVIOUS) {
    try {
      const previous = parseKeyList(env.NOVA_ENCRYPTION_KEYS_PREVIOUS);
      add(
        "previous_keys",
        "warn",
        `${previous.length} previous key(s) readable — finish rotation (media:rotate-key --apply, media:verify) and remove`,
      );
    } catch (err) {
      add("previous_keys", "fail", (err as Error).message.slice(0, 200));
    }
  }

  // 3. Signup / invite policy. Production+open is legal config but almost
  // certainly a mistake for a private alpha — fail so the operator decides.
  if (env.isProduction && env.signupMode === "open") {
    add("signup_policy", "fail", "NOVA_SIGNUP=open in production — anyone can create an account");
  } else if (env.signupMode === "invite" && !env.NOVA_ALPHA_INVITE_CODE) {
    add("signup_policy", "warn", "invite mode without NOVA_ALPHA_INVITE_CODE — NO signup can succeed");
  } else {
    add("signup_policy", "ok", `signup=${env.signupMode}`);
  }

  // 4. Redaction posture (env.ts already refuses unacknowledged off-in-prod).
  const redactionsOff: string[] = [];
  if (env.NOVA_REDACTION === "off") redactionsOff.push("text");
  if (env.NOVA_IMAGE_REDACTION === "off") redactionsOff.push("image");
  if (env.NOVA_SCREENSHOT_STORAGE === "off") {
    add("screenshot_storage", "warn", "kill switch ON — all screenshots stripped");
  } else {
    add("screenshot_storage", "ok");
  }
  add(
    "redaction",
    redactionsOff.length ? (env.isProduction ? "warn" : "warn") : "ok",
    redactionsOff.length ? `${redactionsOff.join("+")} redaction OFF (explicitly acknowledged)` : undefined,
  );

  // 5. Notion config completeness — partial config means a broken connect
  // flow that only surfaces when the user clicks Connect.
  const notionVars = [env.NOTION_CLIENT_ID, env.NOTION_CLIENT_SECRET, env.NOTION_REDIRECT_URI];
  const notionSet = notionVars.filter(Boolean).length;
  if (notionSet === 0) add("notion", "ok", "not configured (integration off)");
  else if (notionSet < 3) add("notion", "fail", `only ${notionSet}/3 NOTION_* vars set`);
  else add("notion", "ok", "configured");

  // 6. Cloud/model features — informational (each is opt-in by design).
  add(
    "cloud_features",
    "ok",
    `live_qa=${env.NOVA_LIVE_QA === "off" ? "off" : env.ANTHROPIC_API_KEY ? "on" : "off (no key)"} ` +
      `transcription+embeddings=${env.OPENAI_API_KEY ? "on" : "off"} analytics=${env.NOVA_ANALYTICS}`,
  );

  // 7. Postgres connectivity + migrations.
  const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    await db.query("SELECT 1");
    add("postgres", "ok");
    try {
      const pending = await pendingMigrations(db);
      add(
        "migrations",
        pending.length ? "fail" : "ok",
        pending.length ? `${pending.length} pending — run db:migrate` : undefined,
      );
    } catch (err) {
      add("migrations", "fail", (err as Error).message.slice(0, 200));
    }
  } catch (err) {
    add("postgres", "fail", (err as Error).message.slice(0, 200));
  } finally {
    await db.end().catch(() => undefined);
  }

  // 8. Redis connectivity (optional component — warn, don't fail).
  if (env.REDIS_URL) {
    const { Redis } = await import("ioredis");
    const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    try {
      await redis.connect();
      await redis.ping();
      add("redis", "ok");
    } catch (err) {
      add("redis", "warn", `unreachable — enrichment/actions/heartbeat degraded: ${(err as Error).message.slice(0, 120)}`);
    } finally {
      redis.disconnect();
    }
  } else {
    add("redis", "warn", "not configured — enrichment skipped, actions queue disabled");
  }

  // 9. Object store write/read/delete probe (only when media is enabled).
  if (env.NOVA_ENCRYPTION_KEY) {
    try {
      const store = storeFromEnv(env);
      await probeStore(store);
      add("media_store", "ok", env.NOVA_MEDIA_STORE);
    } catch (err) {
      add("media_store", "fail", (err as Error).message.slice(0, 200));
    }
  }

  // 10. Session policy sanity.
  add(
    "sessions",
    "ok",
    `web_ttl=${env.NOVA_SESSION_TTL_HOURS}h extension_ttl=${env.NOVA_EXTENSION_SESSION_TTL_HOURS}h`,
  );

  return {
    ok: !checks.some((c) => c.status === "fail"),
    production: env.isProduction,
    checks,
  };
}
