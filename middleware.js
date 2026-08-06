import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "./lib/session";
import { HOME_BY_ROLE, canAccessPath } from "./lib/access-control.mjs";

const publicPaths = new Set(["/login", "/api/auth/login"]);

export async function middleware(request) {
  const { pathname } = request.nextUrl;
  if (publicPaths.has(pathname) || pathname === "/api/telegram/webhook" || pathname === "/api/telegram/speaker-webhook" || pathname.startsWith("/api/media/") || pathname.startsWith("/api/cron/") || pathname.startsWith("/templates/")) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token, process.env.AUTH_SECRET);
  if (session) {
    if (canAccessPath(session.role, pathname, request.method)) return NextResponse.next();
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = HOME_BY_ROLE[session.role] || "/login";
    homeUrl.search = "";
    return NextResponse.redirect(homeUrl);
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "登录已失效，请重新登录" }, { status: 401 });
  }

  const loginUrl = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL) : request.nextUrl.clone();
  loginUrl.pathname = "/login";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
