import type {
  CreateContextMomentRequest,
  CreateContextMomentResponse,
  CreateSessionResponse,
} from "@nova/schema";

/**
 * M12 spike — API client for the Nova browser shell.
 *
 * Auth is IDENTICAL to the extension (M5): the shell never sees a password.
 * The user signs in on the web app, generates a one-time pairing code
 * (Settings → Browser extension), and the shell exchanges it for its own
 * revocable device session token. Any 401 invalidates the stored token so
 * the UI converges on the pairing screen. There is no shell-specific auth
 * mode and no weakening of the session model.
 *
 * fetchImpl is injectable so every branch is unit-testable in CI.
 */

export interface ShellSettings {
  apiUrl: string;
  /** Device session token from the pairing flow ("" = not connected). */
  deviceToken: string;
  /** Email of the paired account, for display only. */
  accountEmail: string;
  /** 'full' sends a downscaled screenshot; 'text_only' never grabs pixels. */
  captureMode: "full" | "text_only";
  /** If server-side image redaction fails, drop the image rather than store
   * it unredacted. The shell defaults this ON (stricter than the extension's
   * default): a privacy-first surface should fail closed. */
  strictRedaction: boolean;
}

export const DEFAULT_SETTINGS: ShellSettings = {
  apiUrl: "http://localhost:3001",
  deviceToken: "",
  accountEmail: "",
  captureMode: "full",
  strictRedaction: true,
};

export class SessionExpiredError extends Error {
  constructor() {
    super("Your Nova session expired or was revoked — pair the shell again.");
    this.name = "SessionExpiredError";
  }
}

type FetchLike = typeof fetch;

/** Exchange a one-time pairing code (from the web app) for a device session. */
export async function claimPairingCode(
  apiUrl: string,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ token: string; email: string }> {
  const res = await fetchImpl(`${apiUrl}/v1/auth/pairing/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.trim() }),
  });
  if (res.status === 401) {
    throw new Error(
      "That code is invalid or expired — generate a new one in the web app.",
    );
  }
  if (res.status === 429) {
    throw new Error("Too many attempts — wait a few minutes and try again.");
  }
  if (!res.ok) {
    throw new Error(
      `Pairing failed (API ${res.status}). Check the API URL and try again.`,
    );
  }
  const body = (await res.json()) as CreateSessionResponse;
  return { token: body.token, email: body.user.email };
}

/** Submit a capture through the existing moments endpoint. The server owns
 * redaction, media encryption, audit, and enrichment — the shell only ever
 * posts and forgets. Throws SessionExpiredError on a dead token so the
 * caller can clear it. */
export async function postMoment(
  settings: ShellSettings,
  body: CreateContextMomentRequest,
  fetchImpl: FetchLike = fetch,
): Promise<CreateContextMomentResponse> {
  if (!settings.deviceToken) throw new SessionExpiredError();
  const res = await fetchImpl(`${settings.apiUrl}/v1/context/moments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.deviceToken}`,
    },
    body: JSON.stringify({
      ...body,
      strict_image_redaction: settings.strictRedaction,
    }),
  });
  if (res.status === 401) throw new SessionExpiredError();
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as CreateContextMomentResponse;
}

/** Revoke this shell's session server-side; the caller forgets it locally. */
export async function revokeSession(
  settings: ShellSettings,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (!settings.deviceToken) return;
  await fetchImpl(`${settings.apiUrl}/v1/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${settings.deviceToken}` },
  }).catch(() => undefined);
}
