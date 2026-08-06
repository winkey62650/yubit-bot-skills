import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE, SESSION_DURATION_SECONDS } from "../../../../lib/session";
import { HOME_BY_ROLE, ROLES } from "../../../../lib/access-control.mjs";

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function sameText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function clientKey(request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function currentAttempt(key) {
  const now = Date.now();
  const attempt = attempts.get(key);
  if (!attempt || now - attempt.startedAt > WINDOW_MS) {
    const fresh = { count: 0, startedAt: now };
    attempts.set(key, fresh);
    return fresh;
  }
  return attempt;
}

export async function POST(request) {
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;
  const manualUsername = process.env.MANUAL_PUBLISHER_USERNAME;
  const manualPassword = process.env.MANUAL_PUBLISHER_PASSWORD;
  const secret = process.env.AUTH_SECRET;
  if (!username || !password || !secret) {
    return NextResponse.json({ ok: false, error: "登录服务尚未配置" }, { status: 503 });
  }

  const key = clientKey(request);
  const attempt = currentAttempt(key);
  if (attempt.count >= MAX_ATTEMPTS) {
    return NextResponse.json({ ok: false, error: "尝试次数过多，请 15 分钟后再试" }, { status: 429 });
  }

  const body = await request.json().catch(() => ({}));
  const accounts = [
    { username, password, role: ROLES.ADMIN },
    ...(manualUsername && manualPassword && manualUsername !== username
      ? [{ username: manualUsername, password: manualPassword, role: ROLES.MANUAL_PUBLISHER }]
      : [])
  ];
  const account = accounts.find((candidate) => sameText(body.username, candidate.username) && sameText(body.password, candidate.password));
  if (!account) {
    attempt.count += 1;
    return NextResponse.json({ ok: false, error: "账号或密码错误" }, { status: 401 });
  }

  attempts.delete(key);
  const response = NextResponse.json({ ok: true, role: account.role, home: HOME_BY_ROLE[account.role] });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: await createSessionToken(account.username, secret, account.role),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS
  });
  return response;
}
