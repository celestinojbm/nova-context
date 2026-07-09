import type {
  ListDestinationsResponse,
  ListIntegrationsResponse,
  ListSessionsResponse,
  MeResponse,
} from "@nova/schema";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ConfirmSubmit } from "../components/ConfirmSubmit";
import { API_URL, apiGet, authHeaders } from "../lib/api";
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

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ notion?: string; pw?: string }>;
}) {
  const { notion: notionParam, pw: pwParam } = await searchParams;
  const notionMessage = notionParam ? (NOTION_MESSAGES[notionParam] ?? null) : null;
  const passwordMessage = pwParam ? (PASSWORD_MESSAGES[pwParam] ?? null) : null;
  const [me, sessions, integrations] = await Promise.all([
    apiGet<MeResponse>("/v1/auth/me"),
    apiGet<ListSessionsResponse>("/v1/auth/sessions"),
    apiGet<ListIntegrationsResponse>("/v1/integrations"),
  ]);
  const notionConnection = integrations.ok
    ? integrations.data.items.find((i) => i.provider === "notion" && i.status === "active")
    : undefined;
  const destinations = notionConnection
    ? await apiGet<ListDestinationsResponse>("/v1/integrations/notion/destinations")
    : null;

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
