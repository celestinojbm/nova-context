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
  // The invite serves BOTH the ops:smoke synthetic account and (M18A,
  // approach B) the in-gate synthetic-session bootstrap that feeds the
  // mandatory authenticated /v1/ops/status check. Without it — and without a
  // pre-supplied NOVA_VALIDATE_SESSION_TOKEN (approach A) — the gate cannot
  // authenticate and is BLOCKED, never a quiet skip (M17B.1 finding 3).
  if (!ctx.flags.invite && !ctx.env.NOVA_SMOKE_INVITE) {
    reasons.push("missing invite code (--invite or NOVA_SMOKE_INVITE) for the synthetic smoke account");
    if (!ctx.env.NOVA_VALIDATE_SESSION_TOKEN) {
      reasons.push(
        "no authentication path for the mandatory authenticated /v1/ops/status check " +
          "(supply an invite for the in-gate synthetic session, or NOVA_VALIDATE_SESSION_TOKEN)",
      );
    }
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
    summary: ctx.env.NOVA_VALIDATE_SESSION_TOKEN
      ? "deployment URL + invite + pre-supplied operator session available (values not printed)"
      : "deployment URL + invite available; authenticated checks use an in-gate synthetic session (created, used in memory, then destroyed)",
  };
}

/** Minimal in-gate API helper (bootstrap/cleanup only). */
async function apiCall(
  base: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL(path, base), {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/**
 * M18A §5 (approach B): create the synthetic validation session INSIDE the
 * gate. The account is created with the synthetic invite, the session token
 * lives only in process memory (ctx.runtime — also fed to the sanitizer so
 * it can never reach argv, reports, or logs), and `synthetic_session_cleanup`
 * (alwaysRun) deletes the account + revokes the session afterwards — even
 * when a later check fails.
 *
 * Approach A remains supported: when NOVA_VALIDATE_SESSION_TOKEN is supplied,
 * it is used as-is and no account is created (nothing to clean up).
 */
export async function syntheticSessionBootstrap(ctx: RunContext): Promise<CheckOutcome> {
  const supplied = ctx.env.NOVA_VALIDATE_SESSION_TOKEN;
  if (supplied) {
    ctx.runtime.session = { token: supplied, email: "", password: "", bootstrapped: false };
    ctx.runtime.extraSecrets.push(supplied);
    return {
      status: "passed",
      summary: "using pre-supplied operator session (approach A); no in-gate account created",
    };
  }
  const base = ctx.flags["base-url"];
  const invite = ctx.flags.invite ?? ctx.env.NOVA_SMOKE_INVITE;
  if (!base || !invite) {
    return { status: "failed", summary: "bootstrap prerequisites absent at check time (prerequisite bypass?)" };
  }
  // Unique per run → reruns are idempotent (no email collision with a
  // previous run's leftover account, which cleanup should have removed).
  const email = `validate-${Date.now().toString(36)}-${randomHex(6)}@nova-validate.invalid`;
  const password = `Vg1-${randomHex(24)}`;
  ctx.runtime.extraSecrets.push(password);
  try {
    const signup = await apiCall(base, "/v1/auth/signup", {
      method: "POST",
      body: { email, password, invite_code: invite },
    });
    if (signup.status !== 201) {
      return { status: "failed", summary: `synthetic signup failed (HTTP ${signup.status})` };
    }
    const login = await apiCall(base, "/v1/auth/login", { method: "POST", body: { email, password } });
    const token = typeof login.body.token === "string" ? login.body.token : null;
    if (login.status !== 200 || !token) {
      return { status: "failed", summary: `synthetic login failed (HTTP ${login.status})` };
    }
    ctx.runtime.session = { token, email, password, bootstrapped: true };
    ctx.runtime.extraSecrets.push(token);
    return {
      status: "passed",
      summary: "in-gate synthetic session created (token held in memory only; account will be deleted by cleanup)",
    };
  } catch (err) {
    return { status: "failed", summary: sanitize(`synthetic bootstrap unreachable: ${(err as Error).message}`) };
  }
}

/**
 * M18A §5: destroy the in-gate synthetic session — ALWAYS runs (never
 * cascade-skipped), so a failure between bootstrap and cleanup cannot leak a
 * synthetic account. Deletion goes through the REAL account-deletion flow
 * (password + typed confirm), which also revokes every session; the check
 * then PROVES cleanup by requiring the deleted credentials to stop working.
 */
export async function syntheticSessionCleanup(ctx: RunContext): Promise<CheckOutcome> {
  const s = ctx.runtime.session;
  if (!s || !s.bootstrapped) {
    // Required checks never self-skip (M17B.1 finding 4). Verifying that no
    // in-gate account exists IS this check's assertion — that's a pass.
    return {
      status: "passed",
      summary: "nothing to clean: no in-gate synthetic account was created (pre-supplied token or bootstrap never ran)",
    };
  }
  const base = ctx.flags["base-url"];
  try {
    const del = await apiCall(base!, "/v1/auth/account/delete", {
      method: "POST",
      token: s.token,
      body: { password: s.password, confirm: "DELETE" },
    });
    if (del.status !== 200) {
      return { status: "failed", summary: `synthetic account deletion failed (HTTP ${del.status}) — manual cleanup required` };
    }
    // Prove cleanup: the deleted account's credentials must be dead.
    const relogin = await apiCall(base!, "/v1/auth/login", {
      method: "POST",
      body: { email: s.email, password: s.password },
    });
    if (relogin.status === 200) {
      return { status: "failed", summary: "synthetic account still authenticates after deletion (cleanup NOT proven)" };
    }
    s.cleaned = true;
    return {
      status: "passed",
      summary: `synthetic account deleted + session revoked (post-delete login HTTP ${relogin.status} — cleanup proven)`,
    };
  } catch (err) {
    return { status: "failed", summary: sanitize(`cleanup unreachable: ${(err as Error).message} — manual cleanup required`) };
  }
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  // M18A: the token comes from the in-memory runtime session (in-gate
  // bootstrap, approach B) or the pre-supplied env token (approach A) —
  // never from argv, never persisted.
  const token = ctx.runtime.session?.token ?? ctx.env.NOVA_VALIDATE_SESSION_TOKEN;
  if (!token) {
    // Defence in depth: prerequisites/bootstrap already fail without an
    // authentication path; a required check must still never self-skip.
    return { status: "failed", summary: "no session token available at check time (prerequisite bypass?)" };
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
