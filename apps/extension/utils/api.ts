import type {
  CreateContextMomentRequest,
  CreateContextMomentResponse,
  ProjectSuggestion,
  SuggestProjectsResponse,
  TranscriptionResponse,
} from "@nova/schema";

import type { CaptureMode } from "@nova/context-engine";

export interface ExtensionSettings {
  apiUrl: string;
  apiToken: string;
  // M4 visual-redaction safeguard: 'full' | 'blurred' | 'text_only'.
  captureMode: CaptureMode;
}

const DEFAULTS: ExtensionSettings = {
  apiUrl: "http://localhost:3001",
  apiToken: "",
  captureMode: "full",
};

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get({
    ...DEFAULTS,
  } as Record<string, unknown>);
  return { ...DEFAULTS, ...stored } as ExtensionSettings;
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set(settings);
}

export async function postMoment(
  settings: ExtensionSettings,
  body: CreateContextMomentRequest,
): Promise<CreateContextMomentResponse> {
  const res = await fetch(`${settings.apiUrl}/v1/context/moments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(settings.apiToken
        ? { authorization: `Bearer ${settings.apiToken}` }
        : {}),
    },
    body: JSON.stringify(body),
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
  const res = await fetch(`${settings.apiUrl}/v1/projects`, {
    headers: settings.apiToken
      ? { authorization: `Bearer ${settings.apiToken}` }
      : {},
  });
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
  const res = await fetch(`${settings.apiUrl}/v1/transcriptions`, {
    method: "POST",
    headers: settings.apiToken
      ? { authorization: `Bearer ${settings.apiToken}` }
      : {},
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
    const res = await fetch(`${settings.apiUrl}/v1/projects/suggest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(settings.apiToken
          ? { authorization: `Bearer ${settings.apiToken}` }
          : {}),
      },
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
  void fetch(`${settings.apiUrl}/v1/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(settings.apiToken ? { authorization: `Bearer ${settings.apiToken}` } : {}),
    },
    body: JSON.stringify({ event, props }),
  }).catch(() => {
    /* analytics never block the UI */
  });
}
