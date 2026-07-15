import type { CheckOutcome, RunContext } from "../types.js";

/**
 * Prerequisite detection (M17B §3). These checks decide BLOCKED vs runnable.
 * They report missing prerequisite NAMES — never values. Missing operator
 * infrastructure is never a test failure and never a PASS.
 */

const missing = (env: NodeJS.ProcessEnv, names: string[]): string[] =>
  names.filter((n) => !env[n] || env[n]!.trim() === "");

/** PR mode: needs only the local CI stack (Postgres + Redis). */
export async function prLocalStack(ctx: RunContext): Promise<CheckOutcome> {
  const absent = missing(ctx.env, ["DATABASE_URL", "REDIS_URL"]);
  if (absent.length) {
    return {
      status: "blocked",
      summary: `local validation stack not configured: missing ${absent.join(", ")}`,
      blockingReasons: absent.map((n) => `missing env: ${n}`),
    };
  }
  return { status: "passed", summary: "local Postgres + Redis configured" };
}

/** Pre-deploy: production env + every operator-supplied secret must EXIST
 * (values never printed). Absence = BLOCKED, not FAIL. */
export async function predeployPrerequisites(ctx: RunContext): Promise<CheckOutcome> {
  const reasons: string[] = [];
  if (ctx.env.NODE_ENV !== "production") {
    reasons.push("NODE_ENV is not 'production' (pre-deploy validates the production posture)");
  }
  const requiredEnv = [
    "DATABASE_URL",
    "REDIS_URL",
    "NOVA_ENCRYPTION_KEY",
    "NOVA_BACKUP_KEY",
    "NOVA_ALPHA_INVITE_CODE",
  ];
  for (const n of missing(ctx.env, requiredEnv)) reasons.push(`missing env: ${n}`);

  // Media store: s3 needs bucket+keys; fs needs a root.
  const store = ctx.env.NOVA_MEDIA_STORE ?? "fs";
  if (store === "s3") {
    for (const n of missing(ctx.env, [
      "NOVA_MEDIA_S3_BUCKET",
      "NOVA_MEDIA_S3_ACCESS_KEY_ID",
      "NOVA_MEDIA_S3_SECRET_ACCESS_KEY",
    ])) {
      reasons.push(`missing env: ${n}`);
    }
  } else if (missing(ctx.env, ["NOVA_MEDIA_FS_ROOT"]).length) {
    reasons.push("missing env: NOVA_MEDIA_FS_ROOT (or set NOVA_MEDIA_STORE=s3 with credentials)");
  }

  if (reasons.length) {
    return {
      status: "blocked",
      summary: `operator prerequisites missing (${reasons.length}) — see blocking reasons`,
      blockingReasons: reasons,
    };
  }
  return { status: "passed", summary: "production env + operator secrets present (values not inspected)" };
}

/** Pre-deploy config SAFETY: prerequisites exist but are configured
 * unsafely → FAIL (never BLOCKED — supplied-but-unsafe is a real failure). */
export async function predeployConfigSafety(ctx: RunContext): Promise<CheckOutcome> {
  const violations: string[] = [];
  if (ctx.env.NOVA_SIGNUP === "open") {
    violations.push("NOVA_SIGNUP=open in production (must be invite or closed)");
  }
  if (ctx.env.NOVA_REDACTION === "off") violations.push("NOVA_REDACTION=off in production");
  if (ctx.env.NOVA_IMAGE_REDACTION === "off") violations.push("NOVA_IMAGE_REDACTION=off in production");
  if (ctx.env.NOVA_SCREENSHOT_STORAGE !== undefined && !["on", "off"].includes(ctx.env.NOVA_SCREENSHOT_STORAGE)) {
    violations.push("NOVA_SCREENSHOT_STORAGE has an unrecognized value");
  }
  if (ctx.env.NOVA_ALLOW_UNSAFE_REDACTION === "yes") {
    violations.push("NOVA_ALLOW_UNSAFE_REDACTION=yes (the unsafe override must not be set)");
  }
  if (
    ctx.env.NOVA_ENCRYPTION_KEY &&
    ctx.env.NOVA_BACKUP_KEY &&
    ctx.env.NOVA_ENCRYPTION_KEY === ctx.env.NOVA_BACKUP_KEY
  ) {
    violations.push("NOVA_BACKUP_KEY equals NOVA_ENCRYPTION_KEY (they must be SEPARATE keys)");
  }
  if (violations.length) {
    return {
      status: "failed",
      summary: `unsafe production configuration: ${violations.join("; ")}`,
    };
  }
  return { status: "passed", summary: "signup invite-only, redaction on, unsafe override unset, keys distinct" };
}

/** First-deploy feature posture: cloud/integration features are expected OFF.
 * Enabled features are DEGRADED (visible, non-blocking) unless the operator
 * explicitly acknowledges via NOVA_VALIDATE_ALLOW_CLOUD=yes after they have
 * been synthetic-smoked. Never hides a mandatory failure. */
export async function predeployFeaturePosture(ctx: RunContext): Promise<CheckOutcome> {
  const enabled: string[] = [];
  if (ctx.env.NOTION_CLIENT_ID) enabled.push("notion");
  if (ctx.env.ANTHROPIC_API_KEY && ctx.env.NOVA_CLOUD_ENRICHMENT !== "off") enabled.push("cloud_enrichment");
  if (ctx.env.ANTHROPIC_API_KEY && ctx.env.NOVA_LIVE_QA !== "off") enabled.push("live_qa");
  if (ctx.env.OPENAI_API_KEY) enabled.push("transcription_embeddings");
  if (!enabled.length) {
    return { status: "passed", summary: "cloud/integration features OFF (first-deploy posture)" };
  }
  const acknowledged = ctx.env.NOVA_VALIDATE_ALLOW_CLOUD === "yes";
  return {
    status: "degraded",
    summary: `enabled beyond first-deploy posture: ${enabled.join(", ")}${acknowledged ? " (operator-acknowledged)" : " — expected OFF until synthetic-smoked"}`,
    warnings: enabled.map((f) => `feature enabled at deploy gate: ${f}`),
  };
}
