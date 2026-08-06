import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { HOME_BY_ROLE } from "../../../../lib/access-control.mjs";
import { SESSION_COOKIE, verifySessionToken } from "../../../../lib/session";

export async function GET() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(SESSION_COOKIE)?.value, process.env.AUTH_SECRET);
  if (!session) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, user: { username: session.sub, role: session.role, home: HOME_BY_ROLE[session.role] } });
}
