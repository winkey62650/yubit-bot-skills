import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "./lib/session";

const publicPaths = new Set(["/login", "/api/auth/login"]);

export async function middleware(request) {
  const { pathname } = request.nextUrl;
  if (publicPaths.has(pathname) || pathname === "/api/telegram/webhook" || pathname === "/api/telegram/speaker-webhook" || pathname.startsWith("/api/media/") || pathname.startsWith("/api/cron/") || pathname.startsWith("/templates/")) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token, process.env.AUTH_SECRET);
  if (session) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "登录已失效，请重新登录" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
