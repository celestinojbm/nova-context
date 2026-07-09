import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Server-side API client (M5). The browser never talks to the API directly:
 * it holds one HttpOnly cookie on the web app's origin, and every page /
 * server action forwards that opaque session token to the API as a Bearer
 * header. Client JS cannot read the token, and the API accepts no cookies —
 * so there is no ambient credential for cross-site requests to ride on.
 */

export const API_URL = process.env.NOVA_API_URL ?? "http://localhost:3001";
export const SESSION_COOKIE = "nova_session";

export async function sessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await sessionToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Expired/revoked sessions land here from any page fetch. */
function handleUnauthorized(): never {
  redirect("/login?error=expired");
}

export async function apiGet<T>(
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      headers: await authHeaders(),
    });
    if (res.status === 401) handleUnauthorized();
    if (!res.ok) return { ok: false, message: `API responded ${res.status}` };
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    rethrowNextControlFlow(err);
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
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify(body),
    });
    if (res.status === 401) handleUnauthorized();
    if (!res.ok) return { ok: false, message: `API responded ${res.status}` };
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    rethrowNextControlFlow(err);
    return {
      ok: false,
      message: `Could not reach the Nova API at ${API_URL}. Is services/api running?`,
    };
  }
}

/** redirect() works by throwing; our catch-all must not swallow it. */
function rethrowNextControlFlow(err: unknown): void {
  if (
    err instanceof Error &&
    "digest" in err &&
    typeof (err as { digest?: unknown }).digest === "string" &&
    (err as { digest: string }).digest.startsWith("NEXT_")
  ) {
    throw err;
  }
}
