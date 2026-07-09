import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { API_URL, sessionToken } from "../../../lib/api";

/**
 * Notion OAuth callback (M6). Notion redirects the browser here; the code
 * and state are relayed server-side to the API, which validates the
 * single-use state, exchanges the code, and stores the token encrypted.
 * The browser only ever sees a redirect back to Settings.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const token = await sessionToken();
  if (!token) redirect("/login");

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const providerError = req.nextUrl.searchParams.get("error");
  if (providerError === "access_denied") redirect("/settings?notion=denied");
  if (!code || !state) redirect("/settings?notion=callback_invalid");

  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/integrations/notion/oauth/callback`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ code, state }),
      cache: "no-store",
    });
  } catch {
    redirect("/settings?notion=api_unreachable");
  }
  if (res.status === 401) redirect("/login?error=expired");
  if (res.status === 400) redirect("/settings?notion=state_invalid");
  if (!res.ok) redirect("/settings?notion=exchange_failed");
  redirect("/settings?notion=connected");
}
