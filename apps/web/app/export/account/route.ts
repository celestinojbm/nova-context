import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { API_URL, sessionToken } from "../../lib/api";

/**
 * Full account export proxy (M10). Same pattern as /export: the web app
 * attaches the session token server-side and streams the API's response.
 * ?media=refs (default) | full passes through.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const token = await sessionToken();
  if (!token) redirect("/login");
  const res = await fetch(`${API_URL}/v1/export/account${req.nextUrl.search}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401) redirect("/login?error=expired");
  if (!res.ok || !res.body) {
    return new Response("Export failed — the Nova API returned an error.", {
      status: 502,
    });
  }
  return new Response(res.body, {
    headers: {
      "content-type": "application/json",
      "content-disposition":
        res.headers.get("content-disposition") ?? "attachment; filename=nova-account-export.json",
    },
  });
}
