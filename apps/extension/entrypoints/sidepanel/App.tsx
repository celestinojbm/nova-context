import { useEffect, useState } from "react";
import {
  fetchProjects,
  loadSettings,
  postMoment,
  saveSettings,
  type ExtensionSettings,
} from "../../utils/api.js";
import {
  captureActiveTab,
  toCreateMomentRequest,
  type CaptureDraft,
} from "../../utils/capture.js";

// M0 side-panel state machine (docs/BUILD_PLAN.md §6):
// idle → capturing → confirm-card → (submit) → idle.
// Voice ("listening") and live mode arrive in M1/M3.
type PanelState = "idle" | "capturing" | "confirm" | "submitting";

export function App() {
  const [state, setState] = useState<PanelState>("idle");
  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [intent, setIntent] = useState("");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      void fetchProjects(s).then(setProjects);
    });
  }, []);

  async function onCapture() {
    setError(null);
    setSuccess(null);
    setState("capturing");
    try {
      const captured = await captureActiveTab();
      setDraft(captured);
      setState("confirm");
    } catch (err) {
      setError((err as Error).message);
      setState("idle");
    }
  }

  async function onSubmit() {
    if (!draft || !settings) return;
    setState("submitting");
    setError(null);
    try {
      const body = toCreateMomentRequest(draft, intent, projectId || null);
      const created = await postMoment(settings, body);
      setSuccess(`Saved. Moment ${created.id.slice(0, 8)}… is in your timeline.`);
      setDraft(null);
      setIntent("");
      setState("idle");
    } catch (err) {
      setError((err as Error).message);
      setState("confirm");
    }
  }

  function onCancel() {
    setDraft(null);
    setIntent("");
    setState("idle");
  }

  async function onSettingsChange(next: ExtensionSettings) {
    setSettings(next);
    await saveSettings(next);
    void fetchProjects(next).then(setProjects);
  }

  return (
    <div className="panel">
      <h1>Nova Context</h1>

      {state === "idle" && (
        <>
          <button className="primary" onClick={() => void onCapture()}>
            Capture this page
          </button>
          {success && <div className="success">{success}</div>}
        </>
      )}

      {state === "capturing" && <div>Capturing the visible tab…</div>}

      {(state === "confirm" || state === "submitting") && draft && (
        <>
          {draft.screenshotDataUrl ? (
            <img className="thumb" src={draft.screenshotDataUrl} alt="Captured tab" />
          ) : (
            <div className="meta">No screenshot available for this page.</div>
          )}
          <div className="meta">
            <strong>{draft.page.title || "Untitled page"}</strong>
            <br />
            {draft.page.url}
          </div>

          <label htmlFor="intent">Why does this matter? (your instruction)</label>
          <textarea
            id="intent"
            rows={3}
            placeholder="e.g. remember this for the pricing project"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            disabled={state === "submitting"}
          />

          <label htmlFor="project">Project</label>
          <select
            id="project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={state === "submitting"}
          >
            <option value="">— none yet —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <div className="row">
            <button
              className="primary"
              onClick={() => void onSubmit()}
              disabled={state === "submitting"}
            >
              {state === "submitting" ? "Saving…" : "Save moment"}
            </button>
            <button onClick={onCancel} disabled={state === "submitting"}>
              Cancel
            </button>
          </div>
        </>
      )}

      {error && <div className="error">{error}</div>}

      {settings && (
        <details className="settings">
          <summary>Settings</summary>
          <div>
            <label htmlFor="apiUrl">API URL</label>
            <input
              id="apiUrl"
              value={settings.apiUrl}
              onChange={(e) =>
                void onSettingsChange({ ...settings, apiUrl: e.target.value })
              }
            />
            <label htmlFor="apiToken">API token (optional)</label>
            <input
              id="apiToken"
              type="password"
              value={settings.apiToken}
              onChange={(e) =>
                void onSettingsChange({ ...settings, apiToken: e.target.value })
              }
            />
          </div>
        </details>
      )}
    </div>
  );
}
