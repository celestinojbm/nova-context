import { apiGet } from "../lib/api";

export const dynamic = "force-dynamic";

/**
 * M11 internal status page. Auth-gated twice over: the web middleware
 * requires the session cookie, and /v1/ops/status is an ordinary /v1
 * route behind the API's fail-closed middleware. Counts and booleans
 * only — no captured content can appear here by construction.
 */

interface OpsStatus {
  ready: boolean;
  checks: Record<string, { ok: boolean; error?: string; detail?: string }>;
  worker: { ok: boolean; last_beat: string | null; detail?: string };
  queues: Record<string, Record<string, number> | { error: string } | null>;
  totals: {
    users?: number;
    moments?: number;
    media_objects?: number;
    media_bytes?: number;
    thumbnail_bytes?: number;
    pending_media_deletes?: number;
    failed_actions?: number;
    error?: string;
  };
  last_maintenance: { mode: string; ran_at: string; report: Record<string, unknown> } | null;
  version: string | null;
  generated_at: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function Light({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <li>
      <span className={ok ? "success" : "error-banner"} style={{ padding: "0 0.4rem" }}>
        {ok ? "OK" : "DOWN"}
      </span>{" "}
      {label}
      {detail ? <span className="muted"> — {detail}</span> : null}
    </li>
  );
}

export default async function StatusPage() {
  const status = await apiGet<OpsStatus>("/v1/ops/status");
  if (!status.ok) {
    return (
      <>
        <h2>System status</h2>
        <div className="error-banner">
          Could not load status from the API: {status.message}
        </div>
      </>
    );
  }
  const s = status.data;
  return (
    <>
      <h2>System status</h2>
      <p className="muted">
        Operational view for the private alpha — component health, queues,
        and maintenance. Counts only; captured content never appears here.
        {s.version ? ` Build: ${s.version}.` : ""} Generated{" "}
        {new Date(s.generated_at).toLocaleString()}.
      </p>

      <h3>Components {s.ready ? "" : "— NOT READY"}</h3>
      <ul>
        {Object.entries(s.checks).map(([name, c]) => (
          <Light key={name} ok={c.ok} label={name} detail={c.detail ?? c.error} />
        ))}
        <Light
          ok={s.worker.ok}
          label="worker"
          detail={
            s.worker.last_beat
              ? `last heartbeat ${new Date(s.worker.last_beat).toLocaleTimeString()}${s.worker.detail ? ` (${s.worker.detail})` : ""}`
              : s.worker.detail
          }
        />
      </ul>

      <h3>Queues</h3>
      {Object.entries(s.queues).map(([name, q]) => (
        <p key={name} className="muted">
          <strong>{name}</strong>:{" "}
          {q === null
            ? "not configured (no Redis)"
            : "error" in q
              ? `error — ${q.error}`
              : `waiting ${q.waiting ?? 0} · active ${q.active ?? 0} · delayed ${q.delayed ?? 0} · failed ${q.failed ?? 0} · completed ${q.completed ?? 0}`}
        </p>
      ))}

      <h3>Data totals</h3>
      {s.totals.error ? (
        <p className="error-banner">{s.totals.error}</p>
      ) : (
        <ul className="muted">
          <li>Users: {s.totals.users}</li>
          <li>Moments: {s.totals.moments}</li>
          <li>
            Media: {s.totals.media_objects} object(s),{" "}
            {formatBytes(s.totals.media_bytes ?? 0)} encrypted
            {(s.totals.thumbnail_bytes ?? 0) > 0 &&
              ` (+ ${formatBytes(s.totals.thumbnail_bytes ?? 0)} thumbnails)`}
          </li>
          <li>Pending media deletes: {s.totals.pending_media_deletes}</li>
          <li>Failed actions: {s.totals.failed_actions}</li>
        </ul>
      )}

      <h3>Last maintenance</h3>
      {s.last_maintenance ? (
        <p className="muted">
          {s.last_maintenance.mode} at{" "}
          {new Date(s.last_maintenance.ran_at).toLocaleString()} — run{" "}
          <code>pnpm --filter @nova/api ops:maintenance</code> for a fresh
          dry-run report.
        </p>
      ) : (
        <p className="muted">
          Never run. Use <code>pnpm --filter @nova/api ops:maintenance</code>{" "}
          (dry-run by default; <code>-- --apply</code> to act).
        </p>
      )}
    </>
  );
}
