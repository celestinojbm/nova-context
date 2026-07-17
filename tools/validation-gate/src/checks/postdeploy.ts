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
  // The invite is MANDATORY: it feeds BOTH the ops:smoke synthetic account and
  // (M17B.1 finding 3 / M18A approach B) the in-gate synthetic-session
  // bootstrap that provides the mandatory authenticated /v1/ops/status check.
  // Without it the gate cannot authenticate and is BLOCKED — never a quiet
  // skip. A pre-supplied NOVA_VALIDATE_SESSION_TOKEN (approach A) is an
  // OPTIONAL override for the authed check; it does not remove the invite need
  // (ops:smoke still creates its own synthetic account).
  if (!ctx.flags.invite && !ctx.env.NOVA_SMOKE_INVITE) {
    reasons.push(
      "missing invite (--invite or NOVA_SMOKE_INVITE) — required for the synthetic smoke account AND the in-gate authenticated session",
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
    summary: ctx.env.NOVA_VALIDATE_SESSION_TOKEN
      ? "deployment URL + invite available; authenticated checks use the pre-supplied operator session (revoked by cleanup)"
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

const CLEANUP_ATTEMPTS = 3;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A synthetic account handle is safe to print for operator cleanup — it is a
 * generated `@nova-validate.invalid` address, never a secret. The password,
 * token, and invite never appear anywhere (they are sanitizer extra-secrets). */
function syntheticHandle(email: string): string {
  return email || "(unknown synthetic account)";
}

/**
 * M18A §5 / M18A.1 finding 4: create the synthetic validation session INSIDE
 * the gate. The account is recorded (state `account_created`) the INSTANT
 * signup succeeds — BEFORE login is attempted — so a login/network failure
 * still leaves an explicit handle for `synthetic_session_cleanup` to recover
 * and delete. Token/password live only in process memory and are sanitizer
 * extra-secrets, so they can never reach argv, reports, or logs.
 *
 * Approach A (pre-supplied NOVA_VALIDATE_SESSION_TOKEN): the token is used
 * as-is, but it is NOT a free pass — cleanup REVOKES it (POST /v1/auth/logout)
 * and proves it is dead, so a supplied live session can never be left active.
 */
export async function syntheticSessionBootstrap(ctx: RunContext): Promise<CheckOutcome> {
  const supplied = ctx.env.NOVA_VALIDATE_SESSION_TOKEN;
  if (supplied) {
    ctx.runtime.session = {
      state: "authenticated",
      email: "",
      password: "",
      token: supplied,
      bootstrapped: false,
    };
    ctx.runtime.extraSecrets.push(supplied);
    return {
      status: "passed",
      summary: "using pre-supplied operator session (approach A); it will be REVOKED + proven dead by cleanup",
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
  // The password AND the invite are sanitizer extra-secrets (M18A.1 review P3).
  ctx.runtime.extraSecrets.push(password, invite);

  // Record the INTENT before calling signup (M18A.1 review P2): if signup
  // commits server-side but the response is lost (timeout / proxy 5xx), the
  // account may exist — cleanup must still have the email+password to verify
  // and delete it rather than falsely reporting "nothing to clean".
  ctx.runtime.session = { state: "signup_attempted", email, password, bootstrapped: true };

  let signupStatus: number;
  try {
    const signup = await apiCall(base, "/v1/auth/signup", {
      method: "POST",
      body: { email, password, invite_code: invite },
    });
    signupStatus = signup.status;
  } catch (err) {
    // Response lost — the account MAY have been created; stays signup_attempted.
    return {
      status: "failed",
      summary: sanitize(`synthetic signup response lost: ${(err as Error).message}; cleanup will verify + delete any created account`),
    };
  }
  if (signupStatus !== 201) {
    // Non-201 could still be a committed-then-5xx account; stays
    // signup_attempted so cleanup verifies rather than assumes.
    return {
      status: "failed",
      summary: `synthetic signup returned HTTP ${signupStatus}; cleanup will verify + delete any created account`,
    };
  }
  // Signup CONFIRMED — the account definitely exists now.
  ctx.runtime.session.state = "account_created";

  try {
    const login = await apiCall(base, "/v1/auth/login", { method: "POST", body: { email, password } });
    const token = typeof login.body.token === "string" ? login.body.token : null;
    if (login.status !== 200 || !token) {
      // Account exists but we could not authenticate. Cleanup recovers it.
      return {
        status: "failed",
        summary: `synthetic login failed (HTTP ${login.status}); account recorded — cleanup will recover + delete it`,
      };
    }
    ctx.runtime.session.token = token;
    ctx.runtime.session.state = "authenticated";
    ctx.runtime.extraSecrets.push(token);
    return {
      status: "passed",
      summary: "in-gate synthetic session created (token in memory only; account deleted by cleanup)",
    };
  } catch (err) {
    // Network failure AFTER signup — the account exists; cleanup recovers it.
    return {
      status: "failed",
      summary: sanitize(`synthetic login unreachable after signup: ${(err as Error).message}; cleanup will recover + delete`),
    };
  }
}

/** Try to (re)obtain a token for the synthetic account, bounded retries. */
async function recoverToken(base: string, email: string, password: string): Promise<string | null> {
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
    try {
      const login = await apiCall(base, "/v1/auth/login", { method: "POST", body: { email, password } });
      if (login.status === 200 && typeof login.body.token === "string") return login.body.token;
    } catch {
      // fall through to retry
    }
    await delay(500 * (attempt + 1));
  }
  return null;
}

/** Delete the synthetic account (real flow: password + typed DELETE), bounded
 * retries against transient network failures. Returns the last HTTP status, or
 * null if every attempt threw. */
async function deleteAccount(
  base: string,
  token: string,
  password: string,
): Promise<number | null> {
  let last: number | null = null;
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
    try {
      const del = await apiCall(base, "/v1/auth/account/delete", {
        method: "POST",
        token,
        body: { password, confirm: "DELETE" },
      });
      last = del.status;
      if (del.status === 200) return 200;
    } catch {
      last = null;
    }
    await delay(500 * (attempt + 1));
  }
  return last;
}

/**
 * M18A §5 / M18A.1 finding 4: destroy the synthetic session — ALWAYS runs
 * (never cascade-skipped), so a failure anywhere after signup cannot leak a
 * synthetic account. Handles every lifecycle state:
 *   - approach A (supplied token): REVOKE via /v1/auth/logout and prove the
 *     token no longer authenticates;
 *   - authenticated (approach B): delete via the real flow, prove dead;
 *   - account_created (login had failed): RECOVER a token via bounded re-login,
 *     then delete + prove; if unrecoverable, FAIL loudly with a sanitized
 *     synthetic handle for operator cleanup — never "nothing to clean".
 * In-memory secret references are cleared once cleanup finishes.
 */
export async function syntheticSessionCleanup(ctx: RunContext): Promise<CheckOutcome> {
  const s = ctx.runtime.session;
  const base = ctx.flags["base-url"];
  if (!s || s.state === "not_started") {
    // Bootstrap never created anything (e.g. signup itself failed).
    return { status: "passed", summary: "no synthetic account was created — nothing to clean" };
  }

  // Approach A: revoke the supplied session and prove it is dead.
  if (!s.bootstrapped) {
    try {
      const logout = await apiCall(base!, "/v1/auth/logout", { method: "POST", token: s.token });
      // Prove revoked: an authed call must now be UNAUTHENTICATED (401).
      // 403 = authenticated-but-forbidden → the session is STILL LIVE (it
      // proves identity was accepted), the opposite of revocation — so only
      // 401 counts as dead (M18A.1 review P1).
      const probe = await apiCall(base!, "/v1/ops/status", { token: s.token });
      const dead = probe.status === 401;
      s.token = undefined;
      s.state = dead ? "cleaned" : "cleanup_failed";
      return dead
        ? { status: "passed", summary: `pre-supplied session REVOKED + proven dead (logout HTTP ${logout.status}, probe HTTP 401)` }
        : {
            status: "failed",
            summary: `pre-supplied session NOT proven revoked (logout HTTP ${logout.status}, probe HTTP ${probe.status}; only 401 proves a dead session) — revoke it manually`,
          };
    } catch (err) {
      s.state = "cleanup_failed";
      return { status: "failed", summary: sanitize(`approach-A revoke unreachable: ${(err as Error).message}`) };
    }
  }

  // Approach B: recover a token if login had failed, then delete + prove.
  let token = s.token;
  if (!token) {
    token = (await recoverToken(base!, s.email, s.password)) ?? undefined;
    if (token) {
      s.token = token;
      ctx.runtime.extraSecrets.push(token);
      s.state = "authenticated";
    }
  }
  if (!token) {
    // No token. Whether this is a genuine failure depends on whether the
    // account is CONFIRMED to exist:
    //   - signup_attempted (unconfirmed): a failed re-login most likely means
    //     the account was never created (or the password never took). We
    //     cannot prove an orphan exists, so PASS but emit the handle so an
    //     operator can double-check (M18A.1 review P2 — never a false
    //     "orphan confirmed", never a false "nothing to clean").
    //   - account_created (confirmed 201): an orphan DEFINITELY exists and we
    //     could not delete it → FAIL loudly with the handle.
    if (s.state === "signup_attempted") {
      s.state = "cleaned";
      return {
        status: "passed",
        summary: `signup was unconfirmed and no matching account could be authenticated after ${CLEANUP_ATTEMPTS} attempts — likely no orphan; verify synthetic handle ${syntheticHandle(s.email)} if in doubt`,
      };
    }
    s.state = "cleanup_failed";
    return {
      status: "failed",
      summary: `could not authenticate to delete the CONFIRMED synthetic account after ${CLEANUP_ATTEMPTS} attempts — MANUAL cleanup required for synthetic handle ${syntheticHandle(s.email)}`,
    };
  }

  s.state = "deletion_attempted";
  const delStatus = await deleteAccount(base!, token, s.password);
  if (delStatus !== 200) {
    s.state = "cleanup_failed";
    return {
      status: "failed",
      summary: `synthetic account deletion failed (HTTP ${delStatus ?? "network error"}) after ${CLEANUP_ATTEMPTS} attempts — MANUAL cleanup required for synthetic handle ${syntheticHandle(s.email)}`,
    };
  }
  // Prove cleanup: the deleted account's credentials must be dead.
  let reloginStatus: number | null = null;
  try {
    const relogin = await apiCall(base!, "/v1/auth/login", {
      method: "POST",
      body: { email: s.email, password: s.password },
    });
    reloginStatus = relogin.status;
  } catch {
    reloginStatus = null; // unreachable at prove-time; deletion already 200'd
  }
  if (reloginStatus === 200) {
    s.state = "cleanup_failed";
    return { status: "failed", summary: "synthetic account still authenticates after deletion (cleanup NOT proven)" };
  }
  // Clear in-memory secret references now that cleanup is done.
  s.token = undefined;
  s.password = "";
  s.state = "cleaned";
  return {
    status: "passed",
    summary: `synthetic account deleted + sessions revoked (post-delete login HTTP ${reloginStatus ?? "unreachable"} — cleanup proven)`,
  };
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
