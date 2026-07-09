import type { ListActionsResponse } from "@nova/schema";
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
  const [proposed, recent] = await Promise.all([
    apiGet<ListActionsResponse>("/v1/actions?status=proposed"),
    apiGet<ListActionsResponse>("/v1/actions"),
  ]);
  if (!proposed.ok) return <div className="error-banner">{proposed.message}</div>;

  const proposedItems = proposed.data.items;
  const decided = recent.ok
    ? recent.data.items.filter((a) => a.status !== "proposed").slice(0, 15)
    : [];

  return (
    <>
      <h2>Action approvals</h2>
      <p className="muted">
        Nova proposes; you decide. Nothing external executes without your
        explicit approval.
      </p>

      <h3>Awaiting your approval ({proposedItems.length})</h3>
      {proposedItems.length === 0 && (
        <p className="muted">Nothing to review. Proposals appear here after enrichment.</p>
      )}
      {proposedItems.map((a) => {
        const payload = a.payload as Record<string, unknown>;
        return (
          <div className="approval-card" key={a.id}>
            <div className="approval-head">
              <strong>{String(payload["title"] ?? a.action_type)}</strong>
              <span className="badge">
                {a.action_type} · tier {a.risk_tier}
              </span>
            </div>
            {typeof payload["detail"] === "string" && payload["detail"] && (
              <p className="muted">{payload["detail"]}</p>
            )}
            <div className="task-meta">
              {a.moment_title ? `From “${a.moment_title}”` : "No source moment"}
              {a.project_name ? ` · ${a.project_name}` : ""}
              {payload["proposed_by"] ? ` · proposed by ${String(payload["proposed_by"])}` : ""}
            </div>
            <div className="row">
              <form action={decide}>
                <input type="hidden" name="id" value={a.id} />
                <input type="hidden" name="decision" value="approve" />
                <button type="submit" className="approve">Approve</button>
              </form>
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
          </span>
        </div>
      ))}
    </>
  );
}
