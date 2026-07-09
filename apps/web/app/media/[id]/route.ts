import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { API_URL, sessionToken } from "../../lib/api";

/**
 * Media proxy (M8). The browser holds no API credential, so thumbnails and
 * full images stream through this route: session cookie → Bearer →
 * decrypted media from the API. Blobs never exist unauthenticated or
 * unencrypted at rest anywhere.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const token = await sessionToken();
  if (!token) redirect("/login");
  const { id } = await params;
  const variant = req.nextUrl.searchParams.get("variant") === "thumb" ? "thumb" : "full";
  const res = await fetch(`${API_URL}/v1/media/${encodeURIComponent(id)}?variant=${variant}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401) redirect("/login?error=expired");
  if (!res.ok || !res.body) return new Response("Not found", { status: 404 });
  return new Response(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "private, max-age=300",
    },
  });
}
