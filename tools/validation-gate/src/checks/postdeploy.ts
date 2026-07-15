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
  if (reasons.length) {
    return {
      status: "blocked",
      summary: "post-deploy prerequisites missing — no real deployment to validate",
      blockingReasons: reasons,
    };
  }
  return { status: "passed", summary: "deployment URL + synthetic-account invite available" };
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

/** Authenticated /v1/ops/status — optional: requires an operator session
 * token (NOVA_VALIDATE_SESSION_TOKEN). Without one it is SKIPPED with a
 * documented safe reason (ops:smoke independently exercises the authed
 * surface with its own synthetic session). */
export async function opsStatusAuthed(ctx: RunContext): Promise<CheckOutcome> {
  const token = ctx.env.NOVA_VALIDATE_SESSION_TOKEN;
  if (!token) {
    return {
      status: "skipped",
      summary:
        "no operator session token supplied (safe: ops:smoke covers the authenticated surface with a synthetic session)",
    };
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
    // Privacy spot-check: the authed status body must not carry raw secrets
    // or captured content (M15-D05). Sanitizer differences reveal leaks.
    const leak = sanitize(text) !== text;
    if (leak) {
      return { status: "failed", summary: "/v1/ops/status body contains redactable content (possible leak)" };
    }
    return {
      status: "passed",
      summary: `/v1/ops/status ok in ${latency}ms (no redactable content in body)`,
      metrics: { ops_status_latency_ms: latency },
    };
  } catch (err) {
    return { status: "failed", summary: sanitize(`/v1/ops/status unreachable: ${(err as Error).message}`) };
  }
}
