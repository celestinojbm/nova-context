import { useEffect, useRef, useState } from "react";
import type { ProjectSuggestion } from "@nova/schema";
import { CAPTURE_MODES, type CaptureMode } from "@nova/context-engine";
import {
  fetchProjects,
  loadSettings,
  postMoment,
  saveSettings,
  suggestProjectsPreview,
  trackEvent,
  transcribeAudio,
  TranscriptionUnavailable,
  type ExtensionSettings,
} from "../../utils/api.js";
import { acceptConsent, hasValidConsent, resetConsent } from "../../utils/consent.js";
import { Onboarding } from "./Onboarding.js";
import {
  captureActiveTab,
  toCreateMomentRequest,
  type CaptureDraft,
} from "../../utils/capture.js";
import { LivePanel } from "./LivePanel.js";
import { PushToTalkRecorder } from "../../utils/voice.js";

// M1 side-panel state machine (docs/BUILD_PLAN.md §6):
// idle → capturing → confirm-card ↔ listening → (submit) → idle.
// Live mode arrives in M3.
type PanelState = "idle" | "capturing" | "confirm" | "submitting" | "live";

export function App() {
  const [state, setState] = useState<PanelState>("idle");
  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [intent, setIntent] = useState("");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [suggestion, setSuggestion] = useState<ProjectSuggestion | null>(null);
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [consented, setConsented] = useState<boolean | null>(null);
  const recorderRef = useRef(new PushToTalkRecorder());

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      void fetchProjects(s).then(setProjects);
      trackEvent(s, "extension_opened");
    });
    void hasValidConsent().then(setConsented);
    const recorder = recorderRef.current;
    return () => recorder.release();
  }, []);

  async function onCapture() {
    if (!settings) return;
    setError(null);
    setSuccess(null);
    setState("capturing");
    trackEvent(settings, "instant_capture_started");
    try {
      const captured = await captureActiveTab(settings.captureMode);
      setDraft(captured);
      setState("confirm");
    } catch (err) {
      setError((err as Error).message);
      trackEvent(settings, "capture_failed", { stage: "capture" });
      setState("idle");
    }
  }

  /** Ask the server which project this likely belongs to, and preselect it.
   * The user can always override; overrides are logged server-side. */
  async function refreshSuggestion(text: string, currentDraft: CaptureDraft | null) {
    if (!settings) return;
    const suggestions = await suggestProjectsPreview(settings, {
      intent_text: text.trim() || null,
      url: currentDraft?.page.url ?? null,
    });
    const top = suggestions[0] ?? null;
    setSuggestion(top);
    if (top) setProjectId((prev) => prev || top.id);
  }

  async function onTalkStart() {
    setError(null);
    try {
      await recorderRef.current.start();
      setListening(true);
    } catch {
      setError("Microphone unavailable or permission denied — type instead.");
    }
  }

  async function onTalkStop() {
    if (!listening || !settings) return;
    setListening(false);
    const clip = await recorderRef.current.stop();
    if (!clip) return;
    setTranscribing(true);
    try {
      const { transcript } = await transcribeAudio(settings, clip);
      // Transcript is editable text — append to whatever was already typed.
      const nextText = [intent.trim(), transcript].filter(Boolean).join(" ");
      setIntent(nextText);
      void refreshSuggestion(nextText, draft);
    } catch (err) {
      setError(
        err instanceof TranscriptionUnavailable
          ? err.message
          : (err as Error).message,
      );
    } finally {
      setTranscribing(false);
    }
  }

  async function onSubmit() {
    if (!draft || !settings) return;
    setState("submitting");
    setError(null);
    try {
      const body = toCreateMomentRequest(draft, intent, projectId || null);
      const created = await postMoment(settings, body);
      const parts = [`Saved moment ${created.id.slice(0, 8)}…`];
      if (created.task) parts.push(`Task created: “${created.task.title}”`);
      setSuccess(parts.join(" "));
      setDraft(null);
      setIntent("");
      setSuggestion(null);
      setProjectId("");
      setState("idle");
    } catch (err) {
      setError((err as Error).message);
      trackEvent(settings, "capture_failed", { stage: "save" });
      setState("confirm");
    }
  }

  function onCancel() {
    recorderRef.current.release();
    setListening(false);
    setDraft(null);
    setIntent("");
    setSuggestion(null);
    setProjectId("");
    setState("idle");
  }

  async function onSettingsChange(next: ExtensionSettings) {
    setSettings(next);
    await saveSettings(next);
    void fetchProjects(next).then(setProjects);
  }

  // M4: consent gate — capture and live mode are unusable until accepted.
  if (consented === false) {
    return (
      <div className="panel">
        <h1>Nova Context</h1>
        <Onboarding
          onAccept={() => {
            void acceptConsent().then(() => {
              setConsented(true);
              if (settings) trackEvent(settings, "onboarding_completed");
            });
          }}
        />
      </div>
    );
  }
  if (consented === null) {
    return <div className="panel"><h1>Nova Context</h1></div>;
  }

  return (
    <div className="panel">
      <h1>Nova Context</h1>

      {state === "idle" && (
        <>
          <button className="primary" onClick={() => void onCapture()}>
            Capture this page
          </button>
          <button
            onClick={() => {
              setError(null);
              setSuccess(null);
              setState("live");
            }}
          >
            ● Start live session
          </button>
          {success && <div className="success">{success}</div>}
        </>
      )}

      {state === "live" && settings && (
        <LivePanel
          settings={settings}
          onExit={(message) => {
            setSuccess(message);
            setState("idle");
          }}
        />
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

          <label htmlFor="intent">Why does this matter? (speak or type)</label>
          <div className="row">
            <button
              className={listening ? "talking" : ""}
              onMouseDown={() => void onTalkStart()}
              onMouseUp={() => void onTalkStop()}
              onMouseLeave={() => listening && void onTalkStop()}
              onTouchStart={() => void onTalkStart()}
              onTouchEnd={() => void onTalkStop()}
              disabled={state === "submitting" || transcribing}
              title="Hold to talk"
            >
              {listening ? "● Listening… release to stop" : "🎤 Hold to talk"}
            </button>
            {transcribing && <span className="meta">Transcribing…</span>}
          </div>
          <div className="disclosure">
            Voice is transcribed by a cloud service (OpenAI Whisper). Audio is
            not stored. Typing works just as well.
          </div>
          <textarea
            id="intent"
            rows={3}
            placeholder="e.g. create a task to compare this with alternatives, for the pricing project"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            onBlur={() => void refreshSuggestion(intent, draft)}
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
                {suggestion?.id === p.id
                  ? ` (suggested · ${Math.round(suggestion.confidence * 100)}%)`
                  : ""}
              </option>
            ))}
          </select>
          {suggestion && (
            <div className="meta">
              Suggested: {suggestion.name} — {suggestion.reason}
            </div>
          )}

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
            <label htmlFor="captureMode">Screenshots</label>
            <select
              id="captureMode"
              value={settings.captureMode}
              onChange={(e) =>
                void onSettingsChange({
                  ...settings,
                  captureMode: e.target.value as CaptureMode,
                })
              }
            >
              {CAPTURE_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <div className="disclosure">
              Text redaction never covers pixels inside screenshots or live
              frames. Use “Blur” or “Text only” if your screen may show
              sensitive content.
            </div>
            <button
              onClick={() => {
                trackEvent(settings, "consent_reset");
                void resetConsent().then(() => setConsented(false));
              }}
            >
              Review / reset consent
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
