import type { ListSessionsResponse, MeResponse } from "@nova/schema";
import { revalidatePath } from "next/cache";
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

export default async function SettingsPage() {
  const [me, sessions] = await Promise.all([
    apiGet<MeResponse>("/v1/auth/me"),
    apiGet<ListSessionsResponse>("/v1/auth/sessions"),
  ]);

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
