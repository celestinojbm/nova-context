import { API_URL } from "../lib/api";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <>
      <h2>Settings & data controls</h2>

      <h3>Export</h3>
      <p className="muted">
        Download everything Nova has saved for you — projects, context moments
        (including payloads), tasks, and actions — as a single JSON file. Your
        context is yours (docs/FIRST_PRINCIPLES.md: export everything).
      </p>
      <p>
        <a className="button-link" href={`${API_URL}/v1/export`} download>
          Export all data as JSON
        </a>
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
