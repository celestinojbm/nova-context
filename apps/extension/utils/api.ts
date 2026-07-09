import type {
  CreateContextMomentRequest,
  CreateContextMomentResponse,
} from "@nova/schema";

export interface ExtensionSettings {
  apiUrl: string;
  apiToken: string;
}

const DEFAULTS: ExtensionSettings = {
  apiUrl: "http://localhost:3001",
  apiToken: "",
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
