import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Locale is derived from the path only. Nothing is stored and nothing is
 * sent to an API. English is the default (the rest of the repo is English);
 * Spanish lives at /es.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const locale = pathname === "/es" || pathname.startsWith("/es/") ? "es" : "en";
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nova-locale", locale);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|star-mask.svg).*)"],
};
