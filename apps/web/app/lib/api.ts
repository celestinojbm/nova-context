/** Server-side API client helpers shared by the web app's pages. */

export const API_URL = process.env.NOVA_API_URL ?? "http://localhost:3001";
const API_TOKEN = process.env.NOVA_API_TOKEN;

export function authHeaders(): Record<string, string> {
  return API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {};
}

export async function apiGet<T>(
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      headers: authHeaders(),
    });
    if (!res.ok) return { ok: false, message: `API responded ${res.status}` };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return {
      ok: false,
      message: `Could not reach the Nova API at ${API_URL}. Is services/api running?`,
    };
  }
}

export async function apiPost<T>(
  path: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, message: `API responded ${res.status}` };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return {
      ok: false,
      message: `Could not reach the Nova API at ${API_URL}. Is services/api running?`,
    };
  }
}
