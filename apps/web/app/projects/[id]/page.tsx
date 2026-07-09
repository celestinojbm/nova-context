import type { ProjectDetailResponse } from "@nova/schema";
import { apiGet } from "../../lib/api";

export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await apiGet<ProjectDetailResponse>(`/v1/projects/${id}`);
  if (!result.ok) return <div className="error-banner">{result.message}</div>;
  const { project, moments, tasks, actions, domains, activity } = result.data;

  return (
    <>
      <h2>{project.name}</h2>
      {project.description && <p className="muted">{project.description}</p>}
      <p>
        <a
          className="button-link"
          href={`/export?project_id=${project.id}`}
          download
        >
          Export this project as JSON
        </a>
      </p>

      {domains.length > 0 && (
        <p className="muted">
          Sources:{" "}
          {domains.map((d) => `${d.domain} (${d.count})`).join(" · ")}
        </p>
      )}

      <h3>Context moments ({moments.length})</h3>
      {moments.length === 0 && <p className="muted">No moments linked yet.</p>}
      {moments.map((m) => (
        <div className="task-row" key={m.id}>
          <span className="task-title">
            {m.source_meta.title ?? "Untitled capture"}
            {m.intent_parsed && (
              <span className="badge">
                {m.intent_parsed.action_type.replace(/_/g, " ")}
              </span>
            )}
            <span className={`badge enrich-${m.enrichment_status}`}>
              {m.enrichment_status}
            </span>
          </span>
          <span className="task-meta">
            {m.summary ? m.summary.slice(0, 80) : (m.intent_text ?? "").slice(0, 80)}
          </span>
          <span className="task-meta">
            {new Date(m.captured_at).toLocaleDateString()}
          </span>
        </div>
      ))}

      <h3>Tasks ({tasks.length})</h3>
      {tasks.length === 0 && <p className="muted">No tasks yet.</p>}
      {tasks.map((t) => (
        <div className={`task-row ${t.status === "done" ? "done" : ""}`} key={t.id}>
          <span className="task-title">{t.title}</span>
          <span className="task-meta">{t.status}</span>
          {t.priority !== "normal" && (
            <span className={`task-meta priority-${t.priority}`}>{t.priority}</span>
          )}
        </div>
      ))}

      <h3>Actions ({actions.length})</h3>
      {actions.length === 0 && <p className="muted">No actions yet.</p>}
      {actions.map((a) => (
        <div className="task-row" key={a.id}>
          <span className="task-title">
            {String((a.payload as Record<string, unknown>)["title"] ?? a.action_type)}
          </span>
          <span className="badge">tier {a.risk_tier}</span>
          <span className="task-meta">{a.status}</span>
        </div>
      ))}

      <h3>Recent activity</h3>
      {activity.map((e) => (
        <div className="task-row" key={`${e.kind}-${e.id}-${e.at}`}>
          <span className="badge">{e.kind}</span>
          <span className="task-title">{e.label}</span>
          <span className="task-meta">{new Date(e.at).toLocaleString()}</span>
        </div>
      ))}
    </>
  );
}
