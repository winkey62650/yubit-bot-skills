const SESSION_COOKIE = "yubit_session";
const SESSION_DURATION_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function textToBase64Url(value) {
  return bytesToBase64Url(encoder.encode(value));
}

function base64UrlToText(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return atob(padded);
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function createSessionToken(username, secret) {
  const payload = textToBase64Url(JSON.stringify({
    sub: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS
  }));
  return `${payload}.${await sign(payload, secret)}`;
}

export async function verifySessionToken(token, secret) {
  if (!token || !secret) return null;
  const [payload, providedSignature, extra] = token.split(".");
  if (!payload || !providedSignature || extra) return null;

  const expectedSignature = await sign(payload, secret);
  if (providedSignature.length !== expectedSignature.length) return null;

  let difference = 0;
  for (let index = 0; index < expectedSignature.length; index += 1) {
    difference |= providedSignature.charCodeAt(index) ^ expectedSignature.charCodeAt(index);
  }
  if (difference !== 0) return null;

  try {
    const session = JSON.parse(base64UrlToText(payload));
    if (!session?.sub || Number(session.exp) <= Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

export { SESSION_COOKIE, SESSION_DURATION_SECONDS };
