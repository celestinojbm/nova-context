"use client";

import { useState } from "react";

/**
 * Extension pairing (M5): shows a one-time 8-digit code the user types into
 * the extension's Connect screen. The code lives 10 minutes, works once,
 * and the resulting extension session can be revoked below.
 */
export function PairExtension() {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pairing", { method: "POST" });
      if (!res.ok) {
        setError(
          res.status === 401
            ? "Your session expired — sign in again."
            : "Could not generate a pairing code. Try again.",
        );
        setCode(null);
        return;
      }
      const body = (await res.json()) as { code: string; expires_at: string };
      setCode(body.code);
      setExpiresAt(body.expires_at);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button onClick={() => void generate()} disabled={busy}>
        {busy ? "Generating…" : code ? "Generate a new code" : "Generate pairing code"}
      </button>
      {code && (
        <p>
          <code className="pairing-code">{code}</code>
          <br />
          <span className="muted">
            Enter this code in the extension&apos;s Connect screen
            {expiresAt
              ? ` before ${new Date(expiresAt).toLocaleTimeString()}`
              : ""}
            . It works once.
          </span>
        </p>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
