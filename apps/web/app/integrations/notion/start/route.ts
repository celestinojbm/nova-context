import { redirect } from "next/navigation";
import { API_URL, sessionToken } from "../../../lib/api";

/**
 * Begin the Notion connect flow (M6). The API mints the single-use state
 * and returns Notion's authorize URL; the browser is sent there. OAuth is
 * a WEB-ONLY flow — the extension never touches it.
 */
export async function GET(): Promise<Response> {
  const token = await sessionToken();
  if (!token) redirect("/login");
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/integrations/notion/oauth/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    redirect("/settings?notion=api_unreachable");
  }
  if (res.status === 401) redirect("/login?error=expired");
  if (res.status === 503) redirect("/settings?notion=not_configured");
  if (!res.ok) redirect("/settings?notion=start_failed");
  const { authorize_url } = (await res.json()) as { authorize_url: string };
  redirect(authorize_url);
}
