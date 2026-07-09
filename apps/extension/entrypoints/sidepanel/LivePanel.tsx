import { useEffect, useRef, useState } from "react";
import type { LiveSessionState } from "../../utils/live.js";
import { LiveSession } from "../../utils/live.js";
import { fetchProjects, postMoment, type ExtensionSettings } from "../../utils/api.js";

/**
 * Live Context Mode v0 UI. Explicit start/stop, always-visible recording
 * indicator with remaining time, grounded Q&A, and "save this moment".
 * "save this" typed into the question box is recognized as a save command.
 */
const SAVE_COMMAND = /^(save|capture) (this|that|it|this moment|the moment)\b/i;

export function LivePanel({
  settings,
  onExit,
}: {
  settings: ExtensionSettings;
  onExit: (message: string | null) => void;
}) {
  const sessionRef = useRef<LiveSession | null>(null);
  const [state, setState] = useState<LiveSessionState | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState("");
  const [, forceTick] = useState(0);

  useEffect(() => {
    const session = new LiveSession();
    sessionRef.current = session;
    session.onUpdate = () => setState(session.state());
    session.onExpired = () => {
      onExit("Live session reached the 30-minute limit and was ended. Buffer discarded.");
    };
    void session
      .start()
      .then(() => setState(session.state()))
      .catch((err) => onExit((err as Error).message));
    void fetchProjects(settings).then(setProjects);

    const ticker = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => {
      clearInterval(ticker);
      // Panel unmount = session over. The buffer dies here, by design.
      session.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = sessionRef.current;
  const live = session?.state() ?? state;

  async function saveMoment(note: string) {
    if (!session) return;
    setBusy(true);
    setNotice(null);
    try {
      const body = session.buildSaveRequest(note, projectId || null);
      const created = await postMoment(settings, body);
      setNotice(
        `Moment saved${created.task ? ` — task “${created.task.title}” created` : ""}. Session continues.`,
      );
    } catch (err) {
      setNotice(`Save failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onAsk() {
    if (!session || !question.trim()) return;
    const text = question.trim();
    setQuestion("");
    // "save this" is a command, not a question.
    if (SAVE_COMMAND.test(text)) {
      await saveMoment(text);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await session.ask(settings, text);
      setState(session.state());
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onStop() {
    session?.stop();
    onExit("Live session ended. The buffer was discarded — only saved moments remain.");
  }

  if (!live) return <div>Starting live session…</div>;

  const mins = Math.floor(live.remainingMs / 60_000);
  const secs = Math.floor((live.remainingMs % 60_000) / 1000);

  return (
    <div className="live-panel">
      <div className="live-indicator">
        <span className="live-dot" /> LIVE — observing this tab · {mins}:
        {String(secs).padStart(2, "0")} left
      </div>
      <div className="meta">
        {live.page.title ?? "Untitled"} · {live.frames} frames · {live.texts} text
        snapshots · {(live.bytes / 1024 / 1024).toFixed(1)}MB buffered (in memory only)
      </div>
      {live.lastError && <div className="disclosure">{live.lastError}</div>}

      <div className="qa-log">
        {live.qa.length === 0 && (
          <div className="muted-small">
            Ask about what you're watching — answers use only the live buffer.
            Type “save this” to keep the current moment.
          </div>
        )}
        {live.qa.map((x, i) => (
          <div key={i} className="qa-item">
            <div className="qa-q">Q: {x.question}</div>
            <div className="qa-a">{x.answer}</div>
          </div>
        ))}
      </div>

      <textarea
        rows={2}
        placeholder='Ask a question, or type "save this"…'
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void onAsk();
          }
        }}
        disabled={busy}
      />
      <label htmlFor="live-project">Project for saved moments</label>
      <select
        id="live-project"
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
      >
        <option value="">— none yet —</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="row">
        <button className="primary" onClick={() => void onAsk()} disabled={busy || !question.trim()}>
          {busy ? "Working…" : "Ask"}
        </button>
        <button onClick={() => void saveMoment("")} disabled={busy}>
          Save this moment
        </button>
        <button className="danger" onClick={onStop}>
          End session
        </button>
      </div>
      {notice && <div className="success">{notice}</div>}
      <div className="disclosure">
        The live buffer stays on this device and is destroyed when the session
        ends. Questions send a small redacted slice (recent frames + visible
        text) to the configured model. Text is auto-redacted; anything visible
        inside the frames themselves is not.
      </div>
    </div>
  );
}
