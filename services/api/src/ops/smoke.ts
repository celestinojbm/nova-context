/**
 * M13 post-deploy smoke suite — walks the whole product surface against a
 * RUNNING deployment over plain HTTP, as a real client would, using ONLY
 * synthetic content (a generated nonce, a 1×1 white PNG). Nothing sensitive
 * is sent, stored, or printed; the synthetic account it creates deletes itself
 * at the end through the real account-deletion flow.
 *
 * M18A.4 P1-2 (NCA-17-002): the synthetic account has an EXPLICIT, failure-safe
 * lifecycle. Its email/password + `account_state_unknown` are recorded BEFORE
 * signup is sent; every stage after that runs under try/finally so cleanup
 * ALWAYS runs — after a lost signup response, a login failure, a network
 * exception, a mid-smoke throw, or a deletion failure. Cleanup may report the
 * account clean ONLY with affirmative evidence: the account is deleted through
 * the real flow AND its access token no longer authenticates (exact HTTP 401)
 * AND its credentials no longer log in (exact HTTP 401). HTTP 200 from delete
 * alone is NOT proof. A cleanup that cannot PROVE the account dead is a `fail`
 * (never "likely clean") — which makes `ok:false` and the command exit non-zero.
 * This mirrors the Validation Gate's `syntheticSessionCleanup` contract (same
 * states, same exact-401 proof) so the two do not diverge.
 *
 * M18A.5 (NCA-17-002 closure): the smoke ALSO mints a device/extension session
 * via pairing. That already-issued device token is a THIRD credential — account
 * deletion revoking the web session says nothing about it. Cleanup therefore
 * retains the device token until verification and requires it to return exactly
 * HTTP 401 on the extension's own authenticated surface (`/v1/context/moments`)
 * alongside the web-token and credential probes. Any other outcome (2xx/3xx/
 * 4xx/5xx, timeout, network failure, inaccessible probe) is NOT proof and
 * FAILs. The device token is a secret on every redaction/cleanup path and is
 * cleared only AFTER the cleanup result is finalized.
 *
 * Step statuses:
 *   ok       — works
 *   degraded — works as configured (e.g. live Q&A 503 without a key,
 *              enrichment queued with no worker) — expected in some deploys
 *   fail     — broken; the command exits 1
 */

export interface SmokeStep {
  step: string;
  status: "ok" | "degraded" | "fail";
  detail?: string;
}

export interface SmokeOptions {
  inviteCode?: string;
  /** Extra wait for async enrichment before checking worker processing. */
  enrichmentWaitMs?: number;
}

type FetchLike = typeof fetch;

/** Smoke-owned synthetic-account lifecycle (mirrors the gate's states). */
type LifecycleState =
  | "not_started"
  | "account_state_unknown"
  | "account_created"
  | "authenticated"
  | "deletion_attempted"
  | "cleaned"
  | "cleanup_failed";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const CLEANUP_ATTEMPTS = 3;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runSmoke(
  baseUrl: string,
  opts: SmokeOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; steps: SmokeStep[] }> {
  const base = baseUrl.replace(/\/+$/, "");
  const steps: SmokeStep[] = [];
  const add = (step: string, status: SmokeStep["status"], detail?: string) =>
    steps.push({ step, status, ...(detail ? { detail } : {}) });

  // Letters-only nonce: search-friendly, unmistakably synthetic.
  const nonce = `smokealpha${Array.from({ length: 10 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join("")}`;
  const email = `${nonce}@alpha.local`;
  // `password` is a SECRET reference: it is never put in any step detail and is
  // cleared on the terminal cleanup path.
  let password: string | "" = `smoke-${nonce}-pass`;

  let webToken = "";
  let deviceToken = "";
  let momentId = "";
  let liveMomentId = "";
  // The smoke-owned synthetic account state — drives failure-safe cleanup.
  let lifecycle: LifecycleState = "not_started";

  const api = async (
    path: string,
    init: RequestInit & { token?: string } = {},
  ): Promise<{ status: number; body: any }> => {
    const { token, ...rest } = init;
    const res = await fetchImpl(`${base}${path}`, {
      ...rest,
      headers: {
        ...(rest.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };

  /** Redact known secret references from a free-text detail (defence in depth;
   * details are already written not to include secrets). M18A.5: the device
   * token is a credential like the others — always on the redaction list. */
  const redact = (s: string): string => {
    let out = s;
    for (const secret of [password, webToken, deviceToken, opts.inviteCode]) {
      if (secret && secret.length >= 3) out = out.split(secret).join("[REDACTED]");
    }
    return out;
  };

  const syntheticHandle = (): string => email || "(unknown synthetic account)";

  /** Try to (re)obtain a token for the synthetic account, bounded retries. */
  const recoverToken = async (): Promise<string | null> => {
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
      try {
        const login = await api("/v1/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        if (login.status === 200 && typeof login.body?.token === "string") return login.body.token;
      } catch {
        // fall through to retry
      }
      await delay(300 * (attempt + 1));
    }
    return null;
  };

  /** Delete via the real flow (password + typed DELETE), bounded retries.
   * Returns the last HTTP status, or null if every attempt threw. */
  const deleteAccount = async (token: string): Promise<number | null> => {
    let last: number | null = null;
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
      try {
        const del = await api("/v1/auth/account/delete", {
          method: "POST",
          token,
          body: JSON.stringify({ password, confirm: "DELETE" }),
        });
        last = del.status;
        if (del.status === 200) return 200;
      } catch {
        last = null;
      }
      await delay(300 * (attempt + 1));
    }
    return last;
  };

  // M18A.5: clears EVERY credential reference — password, web token, AND the
  // device token. Called only AFTER the cleanup result is finalized (the
  // device token must survive until its post-delete 401 probe has run).
  const clearSecrets = () => {
    password = "";
    webToken = "";
    deviceToken = "";
  };

  // -- The product-surface walk. Early `return;` on a hard failure still lets
  //    the finally below run cleanup (M18A.4 P1-2). --------------------------
  const mainFlow = async (): Promise<void> => {
    // 1. Readiness gate.
    try {
      const ready = await api("/readyz");
      add("readyz", ready.status === 200 ? "ok" : "fail", ready.status === 200 ? undefined : `HTTP ${ready.status}`);
      if (ready.status !== 200) return;
    } catch (err) {
      add("readyz", "fail", `unreachable: ${redact((err as Error).message).slice(0, 120)}`);
      return;
    }

    // 2. Signup (invite-aware) + login. Record `account_state_unknown` BEFORE
    //    the request: the instant it is transmitted the account MAY exist, so
    //    cleanup must recover-and-prove rather than assume nothing was created.
    {
      const signupBody: Record<string, string> = { email, password };
      if (opts.inviteCode) signupBody.invite_code = opts.inviteCode;
      lifecycle = "account_state_unknown";
      let signupStatus: number;
      try {
        const signup = await api("/v1/auth/signup", { method: "POST", body: JSON.stringify(signupBody) });
        signupStatus = signup.status;
      } catch (err) {
        // Lost/ambiguous response — the account may have committed. Cleanup
        // recovers-and-proves or FAILs; never assumes clean.
        add("signup", "fail", `response lost: ${redact((err as Error).message).slice(0, 120)}`);
        return;
      }
      if (signupStatus === 201) {
        lifecycle = "account_created";
        add("signup", "ok");
      } else {
        add(
          "signup",
          "fail",
          `HTTP ${signupStatus}${signupStatus === 403 ? " — invite required? pass --invite=<code>" : ""}`,
        );
        return;
      }
      const login = await api("/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      if (login.status === 200 && login.body?.token) {
        webToken = login.body.token;
        lifecycle = "authenticated";
        add("login", "ok");
      } else {
        add("login", "fail", `HTTP ${login.status}`);
        return;
      }
    }

    // 3. Extension pairing: mint a code, claim it for a device session.
    {
      const code = await api("/v1/auth/pairing-codes", { method: "POST", token: webToken, body: "{}" });
      const claim =
        code.status === 201
          ? await api("/v1/auth/pairing/claim", {
              method: "POST",
              body: JSON.stringify({ code: code.body.code }),
            })
          : null;
      if (claim?.status === 201 && claim.body?.token) {
        deviceToken = claim.body.token;
        add("extension_pairing", "ok");
      } else {
        add("extension_pairing", "fail", `code=${code.status} claim=${claim?.status ?? "-"}`);
      }
    }
    const captureToken = deviceToken || webToken;

    // 4. Instant capture with a synthetic screenshot (device token = the
    //    extension's exact path), including redaction + media pipeline checks.
    {
      const capture = await api("/v1/context/moments", {
        method: "POST",
        token: captureToken,
        body: JSON.stringify({
          source_mode: "instant_capture",
          source_meta: { url: `https://alpha.local/${nonce}`, title: `Smoke ${nonce}` },
          payload: {
            dom_extract: { main_text: `synthetic smoke page about ${nonce}` },
            screenshot_data_url: TINY_PNG,
          },
          extracted_text: `Smoke ${nonce}. synthetic smoke page about ${nonce}`,
          intent_text: `remind me to review the ${nonce} dashboard`,
        }),
      });
      if (capture.status === 201) {
        momentId = capture.body.id;
        add("instant_capture", "ok");
        const state = capture.body.image_redaction?.state;
        if (state === "applied") add("visual_redaction", "ok");
        else if (state === "none") add("visual_redaction", "degraded", "no image stored");
        else add("visual_redaction", "degraded", `state=${state}`);
        const media = capture.body.media ?? [];
        if (media.length > 0) {
          const blob = await fetchImpl(`${base}${media[0].url}`, {
            headers: { authorization: `Bearer ${captureToken}` },
          });
          add(
            "media_storage",
            blob.status === 200 ? "ok" : "fail",
            blob.status === 200 ? undefined : `media fetch HTTP ${blob.status}`,
          );
        } else {
          add("media_storage", "degraded", "no media stored (pipeline disabled or image stripped)");
        }
        add(
          "task_creation",
          capture.body.task ? "ok" : "degraded",
          capture.body.task ? undefined : "intent did not produce a Tier-0 task",
        );
      } else {
        add("instant_capture", "fail", `HTTP ${capture.status}`);
        add("visual_redaction", "fail", "no capture to check");
        add("media_storage", "fail", "no capture to check");
        add("task_creation", "fail", "no capture to check");
      }
    }

    // 5. Timeline shows the moment.
    {
      const list = await api("/v1/context/moments?limit=20", { token: webToken });
      const found =
        list.status === 200 && (list.body.items ?? []).some((m: { id: string }) => m.id === momentId);
      add("timeline", found ? "ok" : "fail", found ? undefined : `HTTP ${list.status}`);
    }

    // 6. Search finds it by nonce.
    {
      const search = await api("/v1/memory/search", {
        method: "POST",
        token: webToken,
        body: JSON.stringify({ query: nonce }),
      });
      const found =
        search.status === 200 &&
        (search.body.items ?? search.body.results ?? []).some(
          (m: { id?: string; moment?: { id: string } }) => m.id === momentId || m.moment?.id === momentId,
        );
      add("search", found ? "ok" : "fail", found ? undefined : `HTTP ${search.status}`);
    }

    // 7. Live Q&A — ok when answered, degraded when the deploy has it off.
    {
      const live = await api("/v1/live/answers", {
        method: "POST",
        token: captureToken,
        body: JSON.stringify({
          question: `is the ${nonce} page visible?`,
          context: { text_snippets: [`synthetic smoke page about ${nonce}`] },
        }),
      });
      if (live.status === 200) add("live_qa", "ok");
      else if (live.status === 503) add("live_qa", "degraded", "disabled by config (no key or NOVA_LIVE_QA=off)");
      else add("live_qa", "fail", `HTTP ${live.status}`);
    }

    // 8. Save-from-live.
    {
      const now = new Date().toISOString();
      const save = await api("/v1/context/moments", {
        method: "POST",
        token: captureToken,
        body: JSON.stringify({
          source_mode: "live_context",
          source_meta: { title: `Smoke live ${nonce}` },
          payload: {
            dom_extract: { main_text: `live smoke ${nonce}` },
            live_session: { started_at: now, saved_at: now, duration_ms: 1000, frame_count: 0, qa: [] },
          },
          extracted_text: `live smoke ${nonce}`,
        }),
      });
      if (save.status === 201) {
        liveMomentId = save.body.id;
        add("save_from_live", "ok");
      } else {
        add("save_from_live", "fail", `HTTP ${save.status}`);
      }
    }

    // 9. Approval queue reachable (proposed actions listing).
    {
      const actions = await api("/v1/actions?status=proposed", { token: webToken });
      add("approval_queue", actions.status === 200 ? "ok" : "fail", `HTTP ${actions.status}`);
    }

    // 10. Notion connection status (not connected is fine — reachable is the check).
    {
      const notion = await api("/v1/integrations", { token: webToken });
      add(
        "notion_status",
        notion.status === 200 ? "ok" : "fail",
        notion.status === 200 ? undefined : `HTTP ${notion.status}`,
      );
    }

    // 11. Export — full account document; must carry the moment, no raw pixels.
    {
      const exp = await api("/v1/export/account", { token: webToken });
      const text = JSON.stringify(exp.body ?? "");
      if (exp.status !== 200) add("export", "fail", `HTTP ${exp.status}`);
      else if (!text.includes(nonce)) add("export", "fail", "export missing the smoke moment");
      else add("export", "ok");
    }

    // 12. Worker processing: completes (worker up) or honestly queued/skipped.
    {
      const waitMs = opts.enrichmentWaitMs ?? 5000;
      const deadline = Date.now() + waitMs;
      let status = "unknown";
      while (Date.now() < deadline) {
        const m = await api(`/v1/context/moments/${momentId}`, { token: webToken });
        status = m.body?.enrichment_status ?? m.body?.enrichment?.status ?? "unknown";
        if (status === "completed" || status === "failed") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (status === "completed") add("worker_processing", "ok");
      else if (status === "pending" || status === "processing")
        add("worker_processing", "degraded", "enrichment still queued — worker down or slow");
      else if (status === "skipped")
        add("worker_processing", "degraded", "enrichment skipped (no Redis configured)");
      else add("worker_processing", "degraded", `enrichment_status=${status}`);
    }

    // 13. Delete a moment; verify it is gone.
    {
      const del = await api(`/v1/context/moments/${momentId}`, { method: "DELETE", token: webToken });
      const gone = (await api(`/v1/context/moments/${momentId}`, { token: webToken })).status === 404;
      add("delete_moment", del.status === 200 && gone ? "ok" : "fail", `delete=${del.status} gone=${gone}`);
    }

    // 14. Audit log has rows for all of the above.
    {
      const audit = await api("/v1/audit?limit=10", { token: webToken });
      const hasRows = audit.status === 200 && (audit.body.items ?? []).length > 0;
      add("audit_log", hasRows ? "ok" : "fail", hasRows ? undefined : `HTTP ${audit.status}`);
    }

    // 15. Status page data source + worker heartbeat visibility.
    {
      const status = await api("/v1/ops/status", { token: webToken });
      if (status.status !== 200) add("status_page", "fail", `HTTP ${status.status}`);
      else {
        add("status_page", "ok");
        add(
          "worker_heartbeat",
          status.body.worker?.ok ? "ok" : "degraded",
          status.body.worker?.ok ? undefined : "no fresh heartbeat (worker down or Redis off)",
        );
      }
    }
    void liveMomentId; // removed by the account cascade; nothing else references it
  };

  /**
   * 16. Cleanup — ALWAYS runs (finally), and reports `account_delete` clean ONLY
   * with AFFIRMATIVE dead-account/session evidence:
   *   - recover a token if login had failed (bounded re-login);
   *   - if none can be recovered, FAIL (never "likely clean") with a sanitized
   *     synthetic handle for manual verification;
   *   - delete through the real flow; HTTP 200 alone is NOT proof;
   *   - prove the original token no longer authenticates (exact 401);
   *   - prove the credentials no longer log in (exact 401);
   *   - only both-401 → clean; anything else (200/403/4xx/5xx/timeout) → FAIL.
   */
  const cleanup = async (): Promise<void> => {
    if (lifecycle === "not_started") {
      add("account_delete", "ok", "no synthetic account created — nothing to clean");
      return;
    }
    const handle = syntheticHandle();

    let token = webToken;
    if (!token) {
      const recovered = await recoverToken();
      if (recovered) {
        token = recovered;
        lifecycle = "authenticated";
      }
    }
    if (!token) {
      const kind = lifecycle === "account_created" ? "CONFIRMED" : "possible (signup non-definitive)";
      lifecycle = "cleanup_failed";
      clearSecrets();
      add(
        "account_delete",
        "fail",
        `could not authenticate to delete the ${kind} synthetic account after ${CLEANUP_ATTEMPTS} attempts — MANUAL cleanup/verification required for ${handle}`,
      );
      return;
    }

    lifecycle = "deletion_attempted";
    const delStatus = await deleteAccount(token);
    if (delStatus !== 200) {
      lifecycle = "cleanup_failed";
      clearSecrets();
      add(
        "account_delete",
        "fail",
        `deletion failed (HTTP ${delStatus ?? "network error"}) after ${CLEANUP_ATTEMPTS} attempts — MANUAL cleanup required for ${handle}`,
      );
      return;
    }

    // Prove dead: the web token, the ALREADY-ISSUED device/extension token
    // (M18A.5 / NCA-17-002), AND the credentials must ALL now be
    // UNAUTHENTICATED (exact 401). HTTP 200 from delete was not enough.
    let probeStatus: number | null = null;
    try {
      probeStatus = (await api("/v1/ops/status", { token })).status;
    } catch {
      probeStatus = null;
    }
    // The device token minted via pairing is a THIRD credential — retained
    // (NOT cleared) until this probe. It is probed on the extension's own
    // authenticated surface; a timeout / network failure / inaccessible probe
    // is null → NOT proof → FAIL. If pairing never issued a token there is no
    // third credential to prove (the extension_pairing step already failed).
    const hadDevice = Boolean(deviceToken);
    let deviceStatus: number | null = null;
    if (hadDevice) {
      try {
        deviceStatus = (await api("/v1/context/moments?limit=1", { token: deviceToken })).status;
      } catch {
        deviceStatus = null;
      }
    }
    let reloginStatus: number | null = null;
    try {
      reloginStatus = (await api("/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) })).status;
    } catch {
      reloginStatus = null;
    }
    const tokenDead = probeStatus === 401;
    const deviceDead = !hadDevice || deviceStatus === 401;
    const credsDead = reloginStatus === 401;
    // The cleanup result is now finalized — only NOW may the secret references
    // (password, web token, device token) be cleared.
    clearSecrets();
    if (tokenDead && deviceDead && credsDead) {
      lifecycle = "cleaned";
      add(
        "account_delete",
        "ok",
        hadDevice
          ? "deleted + proven dead (token probe 401, device probe 401, relogin 401)"
          : "deleted + proven dead (token probe 401, relogin 401)",
      );
    } else {
      lifecycle = "cleanup_failed";
      add(
        "account_delete",
        "fail",
        `deletion NOT proven — token probe HTTP ${probeStatus ?? "unreachable"}, ` +
          (hadDevice ? `device probe HTTP ${deviceStatus ?? "unreachable"}, ` : "") +
          `relogin HTTP ${reloginStatus ?? "unreachable"} (only 401 proves a dead account/session); MANUAL verification required for ${handle}`,
      );
    }
  };

  try {
    await mainFlow();
  } catch (err) {
    // A mid-smoke exception is a failure — but cleanup still runs (finally).
    add("smoke_exception", "fail", redact(`unexpected error: ${(err as Error).message}`).slice(0, 160));
  } finally {
    await cleanup();
  }

  return { ok: !steps.some((s) => s.status === "fail"), steps };
}
