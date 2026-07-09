import type {
  ActionPreviewResponse,
  ListActionsResponse,
  ListIntegrationsResponse,
} from "@nova/schema";
import { revalidatePath } from "next/cache";
import { API_URL, apiGet, authHeaders } from "../lib/api";

export const dynamic = "force-dynamic";

async function decide(formData: FormData) {
  "use server";
  const id = formData.get("id");
  const decision = formData.get("decision");
  if (typeof id !== "string" || (decision !== "approve" && decision !== "reject"))
    return;
  await fetch(`${API_URL}/v1/actions/${id}/${decision}`, {
    method: "POST",
    headers: await authHeaders(),
  });
  revalidatePath("/approvals");
}

export default async function ApprovalsPage() {
  const [proposed, recent, integrations] = await Promise.all([
    apiGet<ListActionsResponse>("/v1/actions?status=proposed"),
    apiGet<ListActionsResponse>("/v1/actions"),
    apiGet<ListIntegrationsResponse>("/v1/integrations"),
  ]);
  if (!proposed.ok) return <div className="error-banner">{proposed.message}</div>;

  const proposedItems = proposed.data.items;
  const decided = recent.ok
    ? recent.data.items.filter((a) => a.status !== "proposed").slice(0, 15)
    : [];
  const notionConnected = integrations.ok
    ? integrations.data.items.some((i) => i.provider === "notion" && i.status === "active")
    : false;

  // M6: for external Notion actions, fetch the exact pre-execution preview —
  // what the card shows is what the worker will write.
  const previews = new Map<string, ActionPreviewResponse>();
  await Promise.all(
    proposedItems
      .filter((a) => a.action_type === "notion_page")
      .map(async (a) => {
        const res = await apiGet<ActionPreviewResponse>(`/v1/actions/${a.id}/preview`);
        if (res.ok) previews.set(a.id, res.data);
      }),
  );

  return (
    <>
      <h2>Action approvals</h2>
      <p className="muted">
        Nova proposes; you decide. Nothing external executes without your
        explicit approval, and external writes run in the background after
        you approve — check “Recent decisions” for the outcome.
      </p>

      <h3>Awaiting your approval ({proposedItems.length})</h3>
      {proposedItems.length === 0 && (
        <p className="muted">Nothing to review. Proposals appear here after enrichment.</p>
      )}
      {proposedItems.map((a) => {
        const payload = a.payload as Record<string, unknown>;
        const preview = previews.get(a.id);
        const isNotion = a.action_type === "notion_page";
        return (
          <div className="approval-card" key={a.id}>
            <div className="approval-head">
              <strong>{String(payload["title"] ?? a.action_type)}</strong>
              <span className="badge">
                {a.action_type} · tier {a.risk_tier}
                {isNotion ? " · external write" : ""}
              </span>
            </div>
            {typeof payload["detail"] === "string" && payload["detail"] && !preview && (
              <p className="muted">{payload["detail"]}</p>
            )}

            {preview && (
              <div className="notion-preview">
                <div className="task-meta">
                  Will create a page in{" "}
                  {preview.connection.workspace
                    ? `Notion workspace “${preview.connection.workspace}”`
                    : "your Notion workspace"}
                  {preview.connection.destination
                    ? ` under “${preview.connection.destination.title}”`
                    : " under the most recently edited page you shared with Nova"}
                  . Change the default in Settings.
                </div>
                {preview.source_host && (
                  <div className="task-meta">Source: {preview.source_host}</div>
                )}
                {preview.instruction && (
                  <div className="task-meta">Your instruction: “{preview.instruction}”</div>
                )}
                {preview.moment && (
                  <div className="task-meta">
                    Linked moment: {preview.moment.title ?? preview.moment.id.slice(0, 8)} ·{" "}
                    {new Date(preview.moment.captured_at).toLocaleString()}
                  </div>
                )}
                <details>
                  <summary>Exact page content</summary>
                  {preview.sections.map((s, i) => (
                    <p key={i} className="muted">
                      {s.heading ? <strong>{s.heading}: </strong> : null}
                      {s.text}
                    </p>
                  ))}
                </details>
              </div>
            )}

            <div className="task-meta">
              {a.moment_title ? `From “${a.moment_title}”` : "No source moment"}
              {a.project_name ? ` · ${a.project_name}` : ""}
              {payload["proposed_by"] ? ` · proposed by ${String(payload["proposed_by"])}` : ""}
            </div>
            <div className="row">
              {isNotion && !notionConnected ? (
                <a className="button-link" href="/settings">
                  Connect Notion first
                </a>
              ) : (
                <form action={decide}>
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="decision" value="approve" />
                  <button type="submit" className="approve">
                    {isNotion ? "Approve & send to Notion" : "Approve"}
                  </button>
                </form>
              )}
              <form action={decide}>
                <input type="hidden" name="id" value={a.id} />
                <input type="hidden" name="decision" value="reject" />
                <button type="submit" className="reject">Reject</button>
              </form>
            </div>
          </div>
        );
      })}

      <h3>Recent decisions</h3>
      {decided.map((a) => (
        <div className="task-row" key={a.id}>
          <span className="task-title">
            {String((a.payload as Record<string, unknown>)["title"] ?? a.action_type)}
          </span>
          <span className={`badge status-${a.status}`}>{a.status}</span>
          <span className="task-meta">
            {new Date(a.updated_at).toLocaleString()}
            {a.status === "done" &&
            typeof (a.result as Record<string, unknown> | null)?.["page_url"] === "string" ? (
              <>
                {" · "}
                <a
                  href={String((a.result as Record<string, unknown>)["page_url"])}
                  target="_blank"
                  rel="noreferrer"
                >
                  open in Notion
                </a>
              </>
            ) : null}
          </span>
        </div>
      ))}
    </>
  );
}
