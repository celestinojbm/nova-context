import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "nova_session";

/**
 * Route guard (M5): pages require a session cookie; without one you land on
 * /login, except `/`, which is rewritten to the public landing. This is
 * presence-only (the edge runtime has no database) — real validation happens
 * on every API call, and an expired/revoked token redirects to
 * /login?error=expired from the fetch layer.
 */
export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  // The public landing lives at /welcome so the signed-in timeline at /
  // does not download it. Guests who open / are rewritten there and keep
  // the / URL. /login stays public so the landing can send people to sign in.
  if (pathname === "/login" || pathname === "/welcome") return NextResponse.next();
  if (!req.cookies.get(SESSION_COOKIE)?.value) {
    if (pathname === "/") {
      const url = req.nextUrl.clone();
      url.pathname = "/welcome";
      return NextResponse.rewrite(url);
    }
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
