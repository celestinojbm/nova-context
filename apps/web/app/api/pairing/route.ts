import type { NextRequest } from "next/server";
import { API_URL, sessionToken } from "../../lib/api";

/**
 * Mint an extension pairing code (M5). Called by the Settings page's
 * client component; the session token never leaves the server. SameSite=Lax
 * on the cookie means a cross-site POST arrives without it — and the code
 * is only ever displayed to the signed-in user, never acted on here.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const token = await sessionToken();
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
  // Same-origin check: browsers always send Origin on POST.
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.nextUrl.host) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const res = await fetch(`${API_URL}/v1/auth/pairing-codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({ error: "server_error" }));
  return Response.json(body, { status: res.status });
}
