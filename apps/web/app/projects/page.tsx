import type { ListProjectsResponse } from "@nova/schema";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ConfirmSubmit } from "../components/ConfirmSubmit";
import { API_URL, apiGet, authHeaders } from "../lib/api";

export const dynamic = "force-dynamic";

async function deleteProject(formData: FormData) {
  "use server";
  const id = formData.get("id");
  if (typeof id !== "string") return;
  await fetch(`${API_URL}/v1/projects/${id}?delete_moments=true`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  revalidatePath("/projects");
}

async function createProject(formData: FormData) {
  "use server";
  const name = formData.get("name");
  const description = formData.get("description");
  if (typeof name !== "string") redirect("/projects?error=invalid");
  const res = await fetch(`${API_URL}/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({
      name,
      description: typeof description === "string" && description.trim() ? description : null,
      local_only: formData.get("local_only") === "on",
    }),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    redirect(`/projects?error=${body?.error === "project_limit_reached" ? "limit" : "exists"}`);
  }
  if (!res.ok) redirect("/projects?error=invalid");
  revalidatePath("/projects");
  revalidatePath("/");
  redirect("/projects");
}

const CREATE_ERRORS: Record<string, string> = {
  exists: "A project with that name already exists.",
  limit: "You already have the maximum number of projects.",
  invalid: "Check the project name and try again.",
};

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const result = await apiGet<ListProjectsResponse>("/v1/projects");
  if (!result.ok) return <div className="error-banner">{result.message}</div>;
  const { items } = result.data;

  return (
    <>
      <form action={createProject} className="project-create">
        <label>
          Name
          <input name="name" required maxLength={120} placeholder="Acme API" />
        </label>
        <label>
          Description
          <input name="description" maxLength={2000} placeholder="Optional" />
        </label>
        <label className="checkbox-label">
          <input type="checkbox" name="local_only" />
          Local only — facts stay off assistant tokens
        </label>
        <button type="submit">Create project</button>
      </form>
      {error && CREATE_ERRORS[error] && (
        <div className="error-banner">{CREATE_ERRORS[error]}</div>
      )}
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
