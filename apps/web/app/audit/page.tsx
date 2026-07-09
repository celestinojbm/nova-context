import { apiGet } from "../lib/api";

export const dynamic = "force-dynamic";

interface AuditItem {
  id: string;
  event_type: string;
  label: string;
  subject_kind: string | null;
  subject_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

/**
 * User-visible audit log (M4). Every entry explains WHAT happened; detail
 * carries metadata and counts only — captured content never enters
 * audit_log, and deleted content is not retained here.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type } = await searchParams;
  const qs = type ? `?event_type=${encodeURIComponent(type)}&limit=200` : "?limit=200";
  const result = await apiGet<{ items: AuditItem[] }>(`/v1/audit${qs}`);
  if (!result.ok) return <div className="error-banner">{result.message}</div>;
  const { items } = result.data;
  const types = [...new Set(items.map((i) => i.event_type))].sort();

  return (
    <>
      <h2>Audit log</h2>
      <p className="muted">
        Everything Nova did, in the open: captures, live sessions, cloud
        calls, actions, deletions, exports. Entries record what happened —
        never the captured content itself.
      </p>
      <form className="search-form" action="/audit" method="get">
        <select name="type" defaultValue={type ?? ""}>
          <option value="">All events</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button type="submit">Filter</button>
      </form>

      {items.length === 0 && <p className="muted">No events yet.</p>}
      {items.map((e) => (
        <div className="task-row" key={e.id}>
          <span className="badge">{e.event_type}</span>
          <span className="task-title">{e.label}</span>
          <span className="task-meta detail-json">
            {Object.entries(e.detail ?? {})
              .filter(([, v]) => v !== null && v !== undefined)
              .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
              .join(" · ") || "—"}
          </span>
          <span className="task-meta">{new Date(e.created_at).toLocaleString()}</span>
        </div>
      ))}
    </>
  );
}
