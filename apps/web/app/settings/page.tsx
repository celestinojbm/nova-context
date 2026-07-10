import type {
  ListDatabasePropertiesResponse,
  ListDestinationsResponse,
  ListIntegrationsResponse,
  ListSessionsResponse,
  MediaUsageResponse,
  MeResponse,
  NotionPropertyMapping,
} from "@nova/schema";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ConfirmSubmit } from "../components/ConfirmSubmit";
import { API_URL, apiGet, authHeaders, SESSION_COOKIE } from "../lib/api";
import { PairExtension } from "./PairExtension";

export const dynamic = "force-dynamic";

async function revokeSession(formData: FormData) {
  "use server";
  const id = formData.get("id");
  if (typeof id !== "string") return;
  await fetch(`${API_URL}/v1/auth/sessions/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  revalidatePath("/settings");
}

async function changePassword(formData: FormData) {
  "use server";
  const current = formData.get("current_password");
  const next = formData.get("new_password");
  if (typeof current !== "string" || typeof next !== "string") return;
  const res = await fetch(`${API_URL}/v1/auth/password`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ current_password: current, new_password: next }),
    cache: "no-store",
  });
  if (res.status === 401) redirect("/settings?pw=wrong");
  if (res.status === 429) redirect("/settings?pw=rate");
  if (!res.ok) redirect("/settings?pw=invalid");
  redirect("/settings?pw=changed");
}

async function revokeAllSessions() {
  "use server";
  await fetch(`${API_URL}/v1/auth/sessions/revoke-all`, {
    method: "POST",
    headers: await authHeaders(),
  });
  revalidatePath("/settings");
}

async function setNotionDestination(formData: FormData) {
  "use server";
  const value = formData.get("destination");
  if (typeof value !== "string") return;
  const destination = value === "" ? null : JSON.parse(value);
  await fetch(`${API_URL}/v1/integrations/notion/destination`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ destination }),
    cache: "no-store",
  });
  revalidatePath("/settings");
}

const MAPPING_FIELDS: Array<{ key: keyof NotionPropertyMapping; label: string }> = [
  { key: "title", label: "Title (required)" },
  { key: "summary", label: "Summary" },
  { key: "source_url", label: "Source URL" },
  { key: "tags", label: "Tags" },
  { key: "priority", label: "Priority" },
  { key: "created", label: "Captured at" },
  { key: "moment_ref", label: "Nova moment reference" },
];

async function saveNotionMapping(formData: FormData) {
  "use server";
  const destinationRaw = formData.get("destination");
  if (typeof destinationRaw !== "string" || !destinationRaw) return;
  const destination = JSON.parse(destinationRaw);
  const mapping: Record<string, string | null> = {};
  for (const { key } of MAPPING_FIELDS) {
    const v = formData.get(`map_${key}`);
    mapping[key] = typeof v === "string" && v !== "" ? v : null;
  }
  if (!mapping.title) {
    redirect("/settings?mapping=title_required");
  }
  const res = await fetch(`${API_URL}/v1/integrations/notion/destination`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ destination, property_mapping: mapping }),
    cache: "no-store",
  });
  if (!res.ok) {
    redirect(`/settings?mapping=${res.status === 400 ? "invalid" : "failed"}`);
  }
  redirect("/settings?mapping=saved");
}

async function deleteAccount(formData: FormData) {
  "use server";
  const password = formData.get("password");
  const confirm = formData.get("confirm");
  if (typeof password !== "string" || confirm !== "DELETE") {
    redirect("/settings?account=confirm");
  }
  const res = await fetch(`${API_URL}/v1/auth/account/delete`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ password, confirm: "DELETE" }),
    cache: "no-store",
  });
  if (res.status === 401) redirect("/settings?account=password");
  if (!res.ok) redirect("/settings?account=failed");
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/login?deleted=1");
}

async function submitFeedback(formData: FormData) {
  "use server";
  const category = formData.get("category");
  const message = formData.get("message");
  if (typeof category !== "string" || typeof message !== "string") {
    redirect("/settings?feedback=invalid");
  }
  const res = await fetch(`${API_URL}/v1/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ category, message }),
    cache: "no-store",
  });
  if (res.status === 400) redirect("/settings?feedback=invalid");
  if (!res.ok) redirect("/settings?feedback=failed");
  redirect("/settings?feedback=sent");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function disconnectNotion() {
  "use server";
  await fetch(`${API_URL}/v1/integrations/notion`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  revalidatePath("/settings");
}

const PASSWORD_MESSAGES: Record<string, { kind: "ok" | "error"; text: string }> = {
  changed: { kind: "ok", text: "Password changed. Every other session was signed out." },
  wrong: { kind: "error", text: "Current password is wrong." },
  rate: { kind: "error", text: "Too many attempts — wait a few minutes." },
  invalid: { kind: "error", text: "New password must be at least 10 characters." },
};

const NOTION_MESSAGES: Record<string, { kind: "ok" | "error"; text: string }> = {
  connected: { kind: "ok", text: "Notion connected. Approved Notion actions can now execute." },
  denied: { kind: "error", text: "Notion connection cancelled — no access was granted." },
  state_invalid: {
    kind: "error",
    text: "The connection attempt expired or was invalid. Start again from this page.",
  },
  exchange_failed: { kind: "error", text: "Notion rejected the connection. Try again." },
  not_configured: {
    kind: "error",
    text: "Notion is not configured on the API (NOTION_CLIENT_ID / NOTION_CLIENT_SECRET / NOTION_REDIRECT_URI / NOVA_ENCRYPTION_KEY).",
  },
  callback_invalid: { kind: "error", text: "Notion returned an incomplete callback. Try again." },
  api_unreachable: { kind: "error", text: "Could not reach the Nova API." },
  start_failed: { kind: "error", text: "Could not start the Notion connection. Try again." },
};

const MAPPING_MESSAGES: Record<string, { kind: "ok" | "error"; text: string }> = {
  saved: { kind: "ok", text: "Property mapping saved." },
  invalid: {
    kind: "error",
    text: "Mapping rejected — a mapped property is missing from the database or has an incompatible type.",
  },
  title_required: { kind: "error", text: "The Title property mapping is required." },
  failed: { kind: "error", text: "Could not save the mapping. Try again." },
};

const ACCOUNT_MESSAGES: Record<string, { kind: "ok" | "error"; text: string }> = {
  confirm: { kind: "error", text: 'Type DELETE exactly to confirm account deletion.' },
  password: { kind: "error", text: "Password is wrong — account not deleted." },
  failed: { kind: "error", text: "Account deletion failed. Try again." },
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    notion?: string;
    pw?: string;
    mapping?: string;
    account?: string;
    feedback?: string;
  }>;
}) {
  const {
    notion: notionParam,
    pw: pwParam,
    mapping: mappingParam,
    account: accountParam,
    feedback: feedbackParam,
  } = await searchParams;
  const accountMessage = accountParam ? (ACCOUNT_MESSAGES[accountParam] ?? null) : null;
  const feedbackMessage =
    feedbackParam === "sent"
      ? { ok: true, text: "Thanks — feedback recorded." }
      : feedbackParam === "invalid"
        ? { ok: false, text: "Feedback not sent — text only (no pasted screenshots), 3–4000 characters." }
        : feedbackParam === "failed"
          ? { ok: false, text: "Feedback could not be saved — try again." }
          : null;
  const notionMessage = notionParam ? (NOTION_MESSAGES[notionParam] ?? null) : null;
  const passwordMessage = pwParam ? (PASSWORD_MESSAGES[pwParam] ?? null) : null;
  const mappingMessage = mappingParam ? (MAPPING_MESSAGES[mappingParam] ?? null) : null;
  const [me, sessions, integrations, usage] = await Promise.all([
    apiGet<MeResponse>("/v1/auth/me"),
    apiGet<ListSessionsResponse>("/v1/auth/sessions"),
    apiGet<ListIntegrationsResponse>("/v1/integrations"),
    apiGet<MediaUsageResponse>("/v1/media/usage"),
  ]);
  const notionConnection = integrations.ok
    ? integrations.data.items.find((i) => i.provider === "notion" && i.status === "active")
    : undefined;
  const destinations = notionConnection
    ? await apiGet<ListDestinationsResponse>("/v1/integrations/notion/destinations")
    : null;
  // M9: when the saved default is a database, load its properties so the
  // user can map Nova fields onto them.
  const defaultDestination = destinations?.ok ? destinations.data.default : null;
  const databaseProperties =
    defaultDestination?.type === "database_id"
      ? await apiGet<ListDatabasePropertiesResponse>(
          `/v1/integrations/notion/destinations/${defaultDestination.id}/properties`,
        )
      : null;
  const savedMapping = destinations?.ok ? (destinations.data.property_mapping ?? null) : null;

  return (
    <>
      <h2>Settings & data controls</h2>

      <h3>Account</h3>
      {me.ok ? (
        <p className="muted">
          Signed in as <strong>{me.data.user.email}</strong>
          {me.data.user.display_name ? ` (${me.data.user.display_name})` : ""}.
          This session expires{" "}
          {new Date(me.data.session.expires_at).toLocaleString()}.
        </p>
      ) : (
        <p className="muted">{me.message}</p>
      )}
      {passwordMessage && (
        <div className={passwordMessage.kind === "ok" ? "success" : "error-banner"}>
          {passwordMessage.text}
        </div>
      )}
      <details className="account-tools">
        <summary>Change password</summary>
        <form action={changePassword} className="auth-form">
          <label>
            Current password
            <input type="password" name="current_password" autoComplete="current-password" required />
          </label>
          <label>
            New password (10+ characters)
            <input type="password" name="new_password" autoComplete="new-password" minLength={10} required />
          </label>
          <button type="submit">Change password</button>
          <p className="muted">Changing your password signs out every other session and device.</p>
        </form>
      </details>
      <form action={revokeAllSessions}>
        <button type="submit">Sign out everywhere else</button>
      </form>

      <h3>Integrations</h3>
      {notionMessage && (
        <div className={notionMessage.kind === "ok" ? "success" : "error-banner"}>
          {notionMessage.text}
        </div>
      )}
      <p className="muted">
        Notion is Nova&apos;s first external integration. Connecting lets{" "}
        <em>approved</em> Notion actions create pages in your workspace —
        nothing writes to Notion without your explicit approval, and every
        step lands in the <a href="/audit">audit log</a>. Your Notion token is
        stored encrypted and is never shown to the extension or the browser.
      </p>
      {notionConnection ? (
        <div>
          <p>
            Notion: <strong>connected</strong>
            {notionConnection.external_account
              ? ` to “${notionConnection.external_account}”`
              : ""}{" "}
            <span className="muted">
              (since {new Date(notionConnection.connected_at).toLocaleDateString()})
            </span>
          </p>
          <div>
            <strong>Default destination</strong>
            <p className="muted">
              Where approved Notion pages are created. Only pages and
              databases you shared with the Nova integration appear here;
              without a choice, the most recently edited shared page is used.
            </p>
            {destinations?.ok ? (
              <form action={setNotionDestination} className="export-form">
                <select name="destination" defaultValue={JSON.stringify(destinations.data.default ?? "") === '""' ? "" : JSON.stringify(destinations.data.default)}>
                  <option value="">Most recently edited shared page (default)</option>
                  {destinations.data.items.map((d) => (
                    <option key={d.id} value={JSON.stringify(d)}>
                      {d.title} ({d.type === "database_id" ? "database" : "page"})
                    </option>
                  ))}
                </select>
                <button type="submit">Save destination</button>
              </form>
            ) : (
              <p className="muted">Could not load destinations from Notion right now.</p>
            )}
            {destinations?.ok && destinations.data.default && (
              <p className="muted">
                Current: “{destinations.data.default.title}”
              </p>
            )}
          </div>
          {defaultDestination?.type === "database_id" && (
            <div>
              <strong>Database property mapping</strong>
              <p className="muted">
                Map Nova fields onto “{defaultDestination.title}” properties.
                Enter the exact property name from your Notion database, or
                leave a field blank to skip it. The mapping is validated
                against the live database before it saves.
              </p>
              {mappingMessage && (
                <div className={mappingMessage.kind === "ok" ? "success" : "error-banner"}>
                  {mappingMessage.text}
                </div>
              )}
              {databaseProperties?.ok ? (
                <>
                  <p className="muted">
                    Available properties:{" "}
                    {databaseProperties.data.properties
                      .map((p) => `${p.name} (${p.type})`)
                      .join(", ") || "none"}
                  </p>
                  <form action={saveNotionMapping} className="auth-form">
                    <input
                      type="hidden"
                      name="destination"
                      value={JSON.stringify(defaultDestination)}
                    />
                    {MAPPING_FIELDS.map(({ key, label }) => (
                      <label key={key}>
                        {label}
                        <input
                          type="text"
                          name={`map_${key}`}
                          defaultValue={(savedMapping?.[key] as string | null) ?? ""}
                          placeholder="Notion property name"
                          required={key === "title"}
                        />
                      </label>
                    ))}
                    <button type="submit">Save mapping</button>
                  </form>
                </>
              ) : (
                <p className="muted">
                  Could not load the database&apos;s properties from Notion right now.
                </p>
              )}
            </div>
          )}
          <form action={disconnectNotion}>
            <ConfirmSubmit message="Disconnect Notion? Pending approved Notion actions will fail until you reconnect.">
              Disconnect Notion
            </ConfirmSubmit>
          </form>
        </div>
      ) : (
        <p>
          <a className="button-link" href="/integrations/notion/start">
            Connect Notion
          </a>
        </p>
      )}

      <h3>Browser extension</h3>
      <p className="muted">
        Connect the Nova extension to your account with a one-time pairing
        code. The extension stores only its own revocable session token —
        never your password.
      </p>
      <PairExtension />

      <h3>Sessions & devices</h3>
      <p className="muted">
        Every signed-in browser and paired extension. Revoke anything you
        don&apos;t recognize; revoked sessions stop working immediately.
      </p>
      {sessions.ok && sessions.data.items.length > 0 ? (
        <table className="sessions-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Device</th>
              <th>Last used</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.data.items.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.kind === "extension" ? "Extension" : "Web"}
                  {s.current ? " (this session)" : ""}
                </td>
                <td className="muted">{s.label ?? "—"}</td>
                <td>{new Date(s.last_used_at).toLocaleString()}</td>
                <td>{new Date(s.expires_at).toLocaleDateString()}</td>
                <td>
                  {!s.current && (
                    <form action={revokeSession}>
                      <input type="hidden" name="id" value={s.id} />
                      <button type="submit">Revoke</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">
          {sessions.ok ? "No active sessions." : sessions.message}
        </p>
      )}

      <h3>Storage</h3>
      <p className="muted">
        Encrypted media (screenshots and live frames) stored for your account.
        Counts and sizes only — Nova never shows or shares the content here.
      </p>
      {usage.ok ? (
        <>
          <p>
            <strong>{usage.data.objects}</strong> media object(s),{" "}
            <strong>{formatBytes(usage.data.total_bytes)}</strong> encrypted
            {usage.data.thumbnail_bytes > 0 &&
              ` (+ ${formatBytes(usage.data.thumbnail_bytes)} thumbnails)`}
            {usage.data.pending_deletions > 0 &&
              ` — ${usage.data.pending_deletions} deletion(s) pending retry`}
          </p>
          {usage.data.objects > 0 && (
            <table className="sessions-table">
              <thead>
                <tr>
                  <th>Breakdown</th>
                  <th>Objects</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(usage.data.by_kind).map(([kind, v]) => (
                  <tr key={`kind-${kind}`}>
                    <td>{kind}</td>
                    <td>{v.objects}</td>
                    <td>{formatBytes(v.bytes)}</td>
                  </tr>
                ))}
                {usage.data.by_project.map((p) => (
                  <tr key={`proj-${p.project_id ?? "none"}`}>
                    <td className="muted">
                      {p.project_name ?? (p.project_id ? "(project)" : "No project")}
                    </td>
                    <td>{p.objects}</td>
                    <td>{formatBytes(p.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {usage.data.objects > 0 && (
            <p className="muted">
              Redaction states:{" "}
              {Object.entries(usage.data.by_redaction_state)
                .map(([state, n]) => `${state}: ${n}`)
                .join(", ")}
            </p>
          )}
        </>
      ) : (
        <p className="muted">{usage.message}</p>
      )}

      <h3>Export</h3>
      <p className="muted">
        Download everything Nova has saved for you — projects, context moments
        (including payloads), tasks, and actions — as a single JSON file. Your
        context is yours (docs/FIRST_PRINCIPLES.md: export everything).
      </p>
      <p>
        <a className="button-link" href="/export" download>
          Export all data as JSON
        </a>
      </p>
      <form className="export-form" action="/export" method="get">
        <label>
          From <input type="date" name="from" />
        </label>
        <label>
          To <input type="date" name="to" />
        </label>
        <button type="submit">Export date range</button>
      </form>
      <p className="muted">
        Per-project export: open a project page and use its export link, or
        add <code>?project_id=&lt;id&gt;</code> to the export URL.
      </p>

      <h3>Audit</h3>
      <p className="muted">
        The <a href="/audit">audit log</a> shows every capture, live session,
        cloud call, action decision, sign-in, deletion, and export.
      </p>

      <h3>Deletion</h3>
      <p className="muted">
        Delete any Context Moment from its card on the timeline. Deleting a
        moment also deletes its derived tasks, actions, embeddings, and entity
        links. The audit log records that a deletion happened (source domain
        and counts only) — never the deleted content.
      </p>

      <h3>Account data lifecycle</h3>
      <p className="muted">
        Your context is yours in full. Download everything the account owns —
        including audit history, integration metadata (never tokens), and
        media — or delete the account entirely.
      </p>
      <p>
        <a className="button-link" href="/export/account" download>
          Full account export (media as links)
        </a>{" "}
        <a className="button-link" href="/export/account?media=full" download>
          Full account export (media inlined)
        </a>
      </p>
      {accountMessage && (
        <div className="error-banner">{accountMessage.text}</div>
      )}
      <details className="account-tools">
        <summary>Delete account permanently</summary>
        <p className="muted">
          This removes every project, moment, task, action, media file,
          session, integration token, product event, and audit entry —
          immediately and irreversibly. What survives: a single tombstone
          (deletion date, hashed email, row counts — never content). Pages
          Nova created in Notion stay in your Notion workspace; only Nova&apos;s
          connection and local records are removed. Export first.
        </p>
        <form action={deleteAccount} className="auth-form">
          <label>
            Your password
            <input type="password" name="password" autoComplete="current-password" required />
          </label>
          <label>
            Type <code>DELETE</code> to confirm
            <input type="text" name="confirm" placeholder="DELETE" required />
          </label>
          <ConfirmSubmit message="Permanently delete this account and all its data? This cannot be undone.">
            Delete my account
          </ConfirmSubmit>
        </form>
      </details>

      <h3>Report a problem</h3>
      <p className="muted">
        Alpha feedback goes straight to the operator. Text only — please
        don&apos;t paste screenshots or captured content; describe what
        happened instead. See the{" "}
        <a
          href="https://github.com/celestinojbm/nova-context/blob/main/docs/ALPHA_GUIDE.md"
          target="_blank"
          rel="noreferrer"
        >
          alpha guide
        </a>{" "}
        for what Nova captures and how to export or delete your data.
      </p>
      {feedbackMessage && (
        <div className={feedbackMessage.ok ? "success-banner" : "error-banner"}>
          {feedbackMessage.text}
        </div>
      )}
      <form action={submitFeedback} className="auth-form">
        <label>
          Category
          <select name="category" defaultValue="bug">
            <option value="bug">Bug</option>
            <option value="privacy">Privacy concern</option>
            <option value="capture_failure">Capture failed</option>
            <option value="search_failure">Search didn&apos;t find it</option>
            <option value="live_failure">Live context problem</option>
            <option value="notion_failure">Notion problem</option>
            <option value="ux">UX friction</option>
            <option value="feature">Feature request</option>
          </select>
        </label>
        <label>
          What happened?
          <textarea name="message" rows={4} maxLength={4000} required />
        </label>
        <button type="submit">Send feedback</button>
      </form>

      <h3>Privacy status</h3>
      <ul className="muted">
        <li>
          Capture-time redaction of emails, phone numbers, card numbers, API
          keys/tokens, SSNs, and IBANs is controlled by <code>NOVA_REDACTION</code>{" "}
          on the API (default: on).
        </li>
        <li>
          Live session buffers exist only in the extension's memory and are
          destroyed when a session ends. Only explicitly saved moments persist.
        </li>
        <li>
          Cloud model usage is opt-in per surface: <code>NOVA_LIVE_QA</code>{" "}
          (live answers), <code>NOVA_CLOUD_ENRICHMENT</code> (worker), and
          transcription/embeddings via <code>OPENAI_API_KEY</code>.
        </li>
      </ul>
    </>
  );
}
