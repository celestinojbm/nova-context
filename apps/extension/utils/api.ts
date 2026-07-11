import type {
  CreateContextMomentRequest,
  CreateContextMomentResponse,
  CreateSessionResponse,
  ProjectSuggestion,
  SuggestProjectsResponse,
  TranscriptionResponse,
} from "@nova/schema";

import type { CaptureMode } from "@nova/context-engine";

/**
 * Extension auth (M5): the extension never sees a password. The user signs
 * in on the web app, generates a one-time pairing code (Settings → Browser
 * extension), and the extension exchanges it for its OWN revocable session
 * token — the only credential stored here (chrome.storage.local). Any 401
 * clears the token and surfaces a reconnect prompt.
 */
export interface ExtensionSettings {
  apiUrl: string;
  /** Extension session token from the pairing flow ("" = not connected). */
  deviceToken: string;
  /** Email of the paired account, for display only. */
  accountEmail: string;
  // M4 visual-redaction safeguard: 'full' | 'blurred' | 'text_only'.
  captureMode: CaptureMode;
  /** M7: if server-side image redaction fails, drop the screenshot rather
   * than store it unredacted. */
  strictRedaction: boolean;
}

// M15 (Hermes P1): default to STRICT — if server-side visual redaction
// fails, the screenshot is dropped rather than stored. A private-alpha
// client must never default to unsafe retention. (Production also forces
// this server-side regardless of what the client sends — see M15B.)
// Exported so a unit test can assert the fresh-install default is safe.
export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  apiUrl: "http://localhost:3001",
  deviceToken: "",
  accountEmail: "",
  captureMode: "full",
  strictRedaction: true,
};
const DEFAULTS = DEFAULT_EXTENSION_SETTINGS;

export class SessionExpiredError extends Error {
  constructor() {
    super("Your Nova session expired or was revoked — reconnect the extension.");
    this.name = "SessionExpiredError";
  }
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get({
    ...DEFAULTS,
  } as Record<string, unknown>);
  // Pre-M5 installs stored a shared API token; it no longer authenticates
  // anything, so drop it rather than carry a dead secret around.
  void chrome.storage.local.remove("apiToken");
  return { ...DEFAULTS, ...stored } as ExtensionSettings;
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set(settings);
}

/** All authenticated calls go through here: Bearer token + expiry handling.
 * On 401 the stored token is cleared so every surface converges on the
 * Connect screen. */
export async function authFetch(
  settings: ExtensionSettings,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!settings.deviceToken) throw new SessionExpiredError();
  const res = await fetch(`${settings.apiUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${settings.deviceToken}`,
    },
  });
  if (res.status === 401) {
    await chrome.storage.local.set({ deviceToken: "" });
    throw new SessionExpiredError();
  }
  return res;
}

/** Exchange a one-time pairing code (from the web app) for a device session. */
export async function claimPairingCode(
  apiUrl: string,
  code: string,
): Promise<{ token: string; email: string }> {
  const res = await fetch(`${apiUrl}/v1/auth/pairing/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.trim() }),
  });
  if (res.status === 401) {
    throw new Error("That code is invalid or expired — generate a new one in the web app.");
  }
  if (res.status === 429) {
    throw new Error("Too many attempts — wait a few minutes and try again.");
  }
  if (!res.ok) {
    throw new Error(`Pairing failed (API ${res.status}). Check the API URL and try again.`);
  }
  const body = (await res.json()) as CreateSessionResponse;
  return { token: body.token, email: body.user.email };
}

/** Revoke this extension's session server-side and forget it locally. */
export async function disconnect(settings: ExtensionSettings): Promise<void> {
  if (settings.deviceToken) {
    await fetch(`${settings.apiUrl}/v1/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${settings.deviceToken}` },
    }).catch(() => undefined);
  }
  await chrome.storage.local.set({ deviceToken: "", accountEmail: "" });
}

export async function postMoment(
  settings: ExtensionSettings,
  body: CreateContextMomentRequest,
): Promise<CreateContextMomentResponse> {
  const res = await authFetch(settings, "/v1/context/moments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, strict_image_redaction: settings.strictRedaction }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as CreateContextMomentResponse;
}

export async function fetchProjects(
  settings: ExtensionSettings,
): Promise<Array<{ id: string; name: string }>> {
  const res = await authFetch(settings, "/v1/projects");
  if (!res.ok) return [];
  const body = (await res.json()) as {
    items: Array<{ id: string; name: string }>;
  };
  return body.items;
}

export class TranscriptionUnavailable extends Error {
  constructor() {
    super("Transcription is not available — type your instruction instead.");
    this.name = "TranscriptionUnavailable";
  }
}

/** Upload a recorded voice clip; returns the editable transcript. */
export async function transcribeAudio(
  settings: ExtensionSettings,
  audio: Blob,
): Promise<TranscriptionResponse> {
  const form = new FormData();
  form.append("audio", audio, "voice.webm");
  const res = await authFetch(settings, "/v1/transcriptions", {
    method: "POST",
    body: form,
  });
  if (res.status === 503) throw new TranscriptionUnavailable();
  if (!res.ok) {
    throw new Error("Transcription failed — type your instruction instead.");
  }
  return (await res.json()) as TranscriptionResponse;
}

/** Preview project suggestions for the current instruction + page. */
export async function suggestProjectsPreview(
  settings: ExtensionSettings,
  input: { intent_text: string | null; url: string | null },
): Promise<ProjectSuggestion[]> {
  try {
    const res = await authFetch(settings, "/v1/projects/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return [];
    return ((await res.json()) as SuggestProjectsResponse).suggestions;
  } catch {
    // Suggestions are a convenience; never block the capture flow on them.
    return [];
  }
}

/** Fire-and-forget product event (M4 funnel). Names are allowlisted
 * server-side; props carry counts/flags only — never captured content. */
export function trackEvent(
  settings: ExtensionSettings,
  event: string,
  props: Record<string, number | boolean | string> = {},
): void {
  if (!settings.deviceToken) return;
  void fetch(`${settings.apiUrl}/v1/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.deviceToken}`,
    },
    body: JSON.stringify({ event, props }),
  }).catch(() => {
    /* analytics never block the UI */
  });
}
