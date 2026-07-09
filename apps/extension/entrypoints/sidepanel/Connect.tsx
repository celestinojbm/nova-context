import { useState } from "react";
import { claimPairingCode, type ExtensionSettings } from "../../utils/api.js";

/**
 * Connect screen (M5): pair this extension with a Nova account. The user
 * signs in on the web app, generates a one-time code under Settings →
 * Browser extension, and types it here. The extension receives and stores
 * only its own revocable session token — never a password.
 */
export function Connect({
  settings,
  onSettingsChange,
  notice,
}: {
  settings: ExtensionSettings;
  onSettingsChange: (next: ExtensionSettings) => Promise<void>;
  notice: string | null;
}) {
  const [code, setCode] = useState("");
  const [apiUrl, setApiUrl] = useState(settings.apiUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConnect() {
    setBusy(true);
    setError(null);
    try {
      const url = apiUrl.trim().replace(/\/$/, "");
      const { token, email } = await claimPairingCode(url, code);
      await onSettingsChange({
        ...settings,
        apiUrl: url,
        deviceToken: token,
        accountEmail: email,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="meta">
        Connect Nova to your account. Open the Nova web app, go to{" "}
        <strong>Settings → Browser extension</strong>, generate a pairing
        code, and enter it below. Codes work once and expire after 10
        minutes.
      </p>
      {notice && <div className="error">{notice}</div>}
      <label htmlFor="pairing-code">Pairing code</label>
      <input
        id="pairing-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="8-digit code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        disabled={busy}
      />
      <details className="settings">
        <summary>API URL</summary>
        <input
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          disabled={busy}
        />
      </details>
      <button
        className="primary"
        onClick={() => void onConnect()}
        disabled={busy || !/^\d{8}$/.test(code.trim())}
      >
        {busy ? "Connecting…" : "Connect"}
      </button>
      {error && <div className="error">{error}</div>}
      <p className="meta">
        The extension stores only a revocable session token for this device.
        You can revoke it any time from the web app's Settings page.
      </p>
    </div>
  );
}
