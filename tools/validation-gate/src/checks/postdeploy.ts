import { sanitize } from "../sanitization.js";
import type { CheckOutcome, RunContext } from "../types.js";

/**
 * Post-deploy checks (M17B §3C). Prepared in M17B; they run against a real
 * deployment ONLY when the operator supplies --base-url (+ invite) and
 * explicitly authorizes the run. Synthetic data only — ops:smoke creates a
 * self-deleting synthetic account; nothing here touches real user data.
 */

export async function postdeployPrerequisites(ctx: RunContext): Promise<CheckOutcome> {
  const reasons: string[] = [];
  if (!ctx.flags["base-url"]) {
    reasons.push("missing --base-url (no deployed Nova API to validate)");
  } else if (!/^https?:\/\//.test(ctx.flags["base-url"])) {
    return { status: "failed", summary: "--base-url must be an http(s) URL" };
  }
  if (!ctx.flags.invite && !ctx.env.NOVA_SMOKE_INVITE) {
    reasons.push("missing invite code (--invite or NOVA_SMOKE_INVITE) for the synthetic smoke account");
  }
  // M17B.1 finding 3: a post-deploy PASS must validate the AUTHENTICATED
  // /v1/ops/status endpoint, so the operator session credential is a hard
  // prerequisite — without it the gate is BLOCKED, never a quiet skip.
  if (!ctx.env.NOVA_VALIDATE_SESSION_TOKEN) {
    reasons.push(
      "missing env: NOVA_VALIDATE_SESSION_TOKEN (operator session required for the mandatory authenticated /v1/ops/status check)",
    );
  }
  if (reasons.length) {
    return {
      status: "blocked",
      summary: "post-deploy prerequisites missing — no real deployment to validate",
      blockingReasons: reasons,
    };
  }
  return {
    status: "passed",
    summary: "deployment URL + synthetic-account invite + operator session available (values not printed)",
  };
}

/** Public /readyz: must return HTTP success AND ready:true (booleans-only
 * body per M15 P3). Latency recorded as an observed metric — no SLA in v0. */
export async function readyz(ctx: RunContext): Promise<CheckOutcome> {
  const base = ctx.flags["base-url"];
  const started = Date.now();
  try {
    const res = await fetch(new URL("/readyz", base), { signal: AbortSignal.timeout(15_000) });
    const latency = Date.now() - started;
    const body = (await res.json().catch(() => ({}))) as { ready?: boolean };
    if (res.ok && body.ready === true) {
      return {
        status: "passed",
        summary: `/readyz ready:true in ${latency}ms`,
        metrics: { readyz_latency_ms: latency },
      };
    }
    return {
      status: "failed",
      summary: `/readyz not ready (HTTP ${res.status}, ready=${String(body.ready)})`,
      metrics: { readyz_latency_ms: latency },
    };
  } catch (err) {
    return { status: "failed", summary: sanitize(`/readyz unreachable: ${(err as Error).message}`) };
  }
}

/** Raw-infrastructure error strings the sanitized authed status body must
 * never carry (M15-D05 regression watch). These are stable, well-known
 * dependency error shapes — not exhaustive, but they catch the class the
 * sanitizer's secret patterns alone would miss. */
const RAW_ERROR_PATTERNS: RegExp[] = [
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /AccessDenied/i,
  /getaddrinfo/i,
  /pg_hba|password authentication failed/i,
  /data:image/i, // captured content must never appear (any case)
];

/**
 * Authenticated /v1/ops/status — MANDATORY for a post-deploy PASS
 * (M17B.1 finding 3). The operator session token is a hard prerequisite
 * (checked in postdeployPrerequisites — missing token → BLOCKED before this
 * runs). Failure or leak detection → FAIL.
 *
 * Leak detection is layered, not sanitizer-diff-only:
 *   1. response-schema expectation: the body must parse as a JSON object
 *      (the status endpoint's stable contract);
 *   2. explicit raw-infrastructure/captured-content patterns (above);
 *   3. sanitizer diff (DSNs, keys, tokens, data: URLs).
 */
export async function opsStatusAuthed(ctx: RunContext): Promise<CheckOutcome> {
  const token = ctx.env.NOVA_VALIDATE_SESSION_TOKEN;
  if (!token) {
    // Defence in depth: prerequisites already block on a missing token; a
    // required check must still never self-skip into a PASS.
    return { status: "failed", summary: "operator session token absent at check time (prerequisite bypass?)" };
  }
  const started = Date.now();
  try {
    const res = await fetch(new URL("/v1/ops/status", ctx.flags["base-url"]), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const latency = Date.now() - started;
    if (!res.ok) return { status: "failed", summary: `/v1/ops/status HTTP ${res.status}` };
    const text = await res.text();
    // 1. Schema expectation: a JSON object per the endpoint contract.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: "failed", summary: "/v1/ops/status body is not valid JSON (contract violation)" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "failed", summary: "/v1/ops/status body is not a JSON object (contract violation)" };
    }
    // 2. Known raw-error / captured-content patterns.
    for (const re of RAW_ERROR_PATTERNS) {
      if (re.test(text)) {
        return {
          status: "failed",
          summary: `/v1/ops/status body matches a forbidden raw-infrastructure/content pattern (${re.source})`,
        };
      }
    }
    // 3. Sanitizer diff (secret shapes: DSNs, keys, bearer tokens, data: URLs).
    if (sanitize(text, { extraSecrets: [token] }) !== text) {
      return { status: "failed", summary: "/v1/ops/status body contains redactable content (possible leak)" };
    }
    return {
      status: "passed",
      summary: `/v1/ops/status ok in ${latency}ms (JSON contract + no forbidden patterns + no redactable content)`,
      metrics: { ops_status_latency_ms: latency },
    };
  } catch (err) {
    return { status: "failed", summary: sanitize(`/v1/ops/status unreachable: ${(err as Error).message}`) };
  }
}
