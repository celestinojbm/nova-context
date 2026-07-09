import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "nova_session";

/**
 * Route guard (M5): pages require a session cookie; without one you land on
 * /login. This is presence-only (the edge runtime has no database) — real
 * validation happens on every API call, and an expired/revoked token
 * redirects to /login?error=expired from the fetch layer.
 */
export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (pathname === "/login") return NextResponse.next();
  if (!req.cookies.get(SESSION_COOKIE)?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
