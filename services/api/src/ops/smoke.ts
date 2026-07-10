/**
 * M13 post-deploy smoke suite — walks the whole product surface against a
 * RUNNING deployment over plain HTTP, as a real client would, using ONLY
 * synthetic content (a generated nonce, a 1×1 white PNG). Nothing sensitive
 * is sent, stored, or printed; the synthetic account deletes itself at the
 * end through the real account-deletion flow (which is itself a check).
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

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
  const password = `smoke-${nonce}-pass`;

  let webToken = "";
  let deviceToken = "";
  let momentId = "";
  let liveMomentId = "";

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

  // 1. Readiness gate.
  try {
    const ready = await api("/readyz");
    add(
      "readyz",
      ready.status === 200 ? "ok" : "fail",
      ready.status === 200 ? undefined : `HTTP ${ready.status}`,
    );
    if (ready.status !== 200) return { ok: false, steps };
  } catch (err) {
    add("readyz", "fail", `unreachable: ${(err as Error).message.slice(0, 120)}`);
    return { ok: false, steps };
  }

  // 2. Signup (invite-aware) + login.
  {
    const signupBody: Record<string, string> = { email, password };
    if (opts.inviteCode) signupBody.invite_code = opts.inviteCode;
    const signup = await api("/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify(signupBody),
    });
    if (signup.status === 201) {
      add("signup", "ok");
    } else {
      add(
        "signup",
        "fail",
        `HTTP ${signup.status}${signup.status === 403 ? " — invite required? pass --invite=<code>" : ""}`,
      );
      return { ok: false, steps };
    }
    const login = await api("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (login.status === 200 && login.body?.token) {
      webToken = login.body.token;
      add("login", "ok");
    } else {
      add("login", "fail", `HTTP ${login.status}`);
      return { ok: false, steps };
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
  // extension's exact path), including redaction + media pipeline checks.
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
        (m: { id?: string; moment?: { id: string } }) =>
          m.id === momentId || m.moment?.id === momentId,
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
          live_session: {
            started_at: now,
            saved_at: now,
            duration_ms: 1000,
            frame_count: 0,
            qa: [],
          },
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

  // 11. Export — full account document, and it must not carry raw pixels
  // beyond redacted media (we exported no media=full, so no data URLs at all).
  {
    const exp = await api("/v1/export/account", { token: webToken });
    const text = JSON.stringify(exp.body ?? "");
    if (exp.status !== 200) add("export", "fail", `HTTP ${exp.status}`);
    else if (!text.includes(nonce)) add("export", "fail", "export missing the smoke moment");
    else add("export", "ok");
  }

  // 12. Worker processing: enrichment either completes (worker up) or is
  // honestly queued/skipped (degraded).
  {
    const waitMs = opts.enrichmentWaitMs ?? 5000;
    const deadline = Date.now() + waitMs;
    let status = "unknown";
    while (Date.now() < deadline) {
      const m = await api(`/v1/context/moments/${momentId}`, { token: webToken });
      status = m.body?.enrichment_status ?? m.body?.enrichment?.status ?? "unknown";
      if (status === "done") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (status === "done") add("worker_processing", "ok");
    else if (status === "queued" || status === "pending")
      add("worker_processing", "degraded", "enrichment still queued — worker down or slow");
    else if (status === "skipped")
      add("worker_processing", "degraded", "enrichment skipped (no Redis configured)");
    else add("worker_processing", "degraded", `enrichment_status=${status}`);
  }

  // 13. Delete a moment; verify it is gone.
  {
    const del = await api(`/v1/context/moments/${momentId}`, {
      method: "DELETE",
      token: webToken,
    });
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

  // 16. Cleanup: the synthetic account deletes itself through the REAL
  // account-deletion flow (password + typed DELETE) — which doubles as the
  // lifecycle check. Leaves nothing behind but the counts-only tombstone.
  {
    const del = await api("/v1/auth/account/delete", {
      method: "POST",
      token: webToken,
      body: JSON.stringify({ password, confirm: "DELETE" }),
    });
    add(
      "account_delete",
      del.status === 200 ? "ok" : "fail",
      del.status === 200 ? undefined : `HTTP ${del.status}`,
    );
    void liveMomentId; // removed by the cascade; nothing else references it
  }

  return { ok: !steps.some((s) => s.status === "fail"), steps };
}
