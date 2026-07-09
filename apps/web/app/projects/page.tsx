import type { ListProjectsResponse } from "@nova/schema";
import { revalidatePath } from "next/cache";
import { ConfirmSubmit } from "../components/ConfirmSubmit";
import { API_URL, apiGet, authHeaders } from "../lib/api";

export const dynamic = "force-dynamic";

async function deleteProject(formData: FormData) {
  "use server";
  const id = formData.get("id");
  if (typeof id !== "string") return;
  await fetch(`${API_URL}/v1/projects/${id}?delete_moments=true`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  revalidatePath("/projects");
}

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
          <form action={deleteProject} className="moment-delete">
            <input type="hidden" name="id" value={p.id} />
            <ConfirmSubmit
              message={`Delete project "${p.name}" INCLUDING its ${p.moment_count} moment(s), tasks, and actions? This cannot be undone.`}
            >
              Delete
            </ConfirmSubmit>
          </form>
        </div>
      ))}
    </>
  );
}
