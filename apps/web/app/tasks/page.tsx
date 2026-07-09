import type { ListTasksResponse } from "@nova/schema";
import { revalidatePath } from "next/cache";
import { API_URL, apiGet, authHeaders } from "../lib/api";

export const dynamic = "force-dynamic";

async function toggleTask(formData: FormData) {
  "use server";
  const id = formData.get("id");
  const next = formData.get("next");
  if (typeof id !== "string" || (next !== "open" && next !== "done")) return;
  await fetch(`${API_URL}/v1/tasks/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ status: next }),
  });
  revalidatePath("/tasks");
}

export default async function TasksPage() {
  const result = await apiGet<ListTasksResponse>("/v1/tasks");
  if (!result.ok) {
    return <div className="error-banner">{result.message}</div>;
  }
  const { items } = result.data;

  if (items.length === 0) {
    return (
      <div className="empty">
        <p>No tasks yet.</p>
        <p className="muted">
          Capture a page and say something like “create a task to compare this
          with alternatives” — the task will show up here, linked to the
          captured moment.
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="muted">
        {items.length} task{items.length === 1 ? "" : "s"} · created by the
        Action Engine (Tier 0) from your capture instructions
      </p>
      {items.map((t) => (
        <div className={`task-row ${t.status === "done" ? "done" : ""}`} key={t.id}>
          <form action={toggleTask} className="task-toggle">
            <input type="hidden" name="id" value={t.id} />
            <input
              type="hidden"
              name="next"
              value={t.status === "done" ? "open" : "done"}
            />
            <button type="submit">
              {t.status === "done" ? "Reopen" : "Done"}
            </button>
          </form>
          <span className="task-title">{t.title}</span>
          {t.priority !== "normal" && (
            <span className={`task-meta priority-${t.priority}`}>{t.priority}</span>
          )}
          <span className="task-meta">
            {t.project_name ?? "no project"}
            {t.moment_title ? ` · from “${t.moment_title}”` : ""}
          </span>
          <span className="task-meta">
            {new Date(t.created_at).toLocaleDateString()}
          </span>
        </div>
      ))}
    </>
  );
}
