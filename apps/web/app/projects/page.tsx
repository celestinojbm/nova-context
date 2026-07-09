import type { ListProjectsResponse } from "@nova/schema";
import { apiGet } from "../lib/api";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const result = await apiGet<ListProjectsResponse>("/v1/projects");
  if (!result.ok) return <div className="error-banner">{result.message}</div>;
  const { items } = result.data;

  return (
    <>
      <p className="muted">
        {items.length} project{items.length === 1 ? "" : "s"}
      </p>
      {items.map((p) => (
        <div className="task-row" key={p.id}>
          <span className="task-title">
            <a href={`/projects/${p.id}`}>{p.name}</a>
          </span>
          {p.description && <span className="task-meta">{p.description}</span>}
          <span className="task-meta">
            {p.moment_count} moment{p.moment_count === 1 ? "" : "s"} ·{" "}
            {p.task_count} task{p.task_count === 1 ? "" : "s"}
          </span>
        </div>
      ))}
    </>
  );
}
