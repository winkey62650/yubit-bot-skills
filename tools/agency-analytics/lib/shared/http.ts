import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError, ValidationError } from "./errors";

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function jsonError(error: unknown, requestId: string) {
  const normalized =
    error instanceof ZodError
      ? new ValidationError(error.issues.map((issue) => issue.message).join("; "))
      : error;

  if (normalized instanceof AppError) {
    return NextResponse.json(
      { ok: false, error: { code: normalized.code, message: normalized.message, requestId } },
      { status: normalized.statusCode },
    );
  }

  process.stderr.write(
    `${JSON.stringify({ level: "error", message: "Unhandled API error", requestId, error: normalized instanceof Error ? normalized.message : String(normalized) })}\n`,
  );
  return NextResponse.json(
    { ok: false, error: { code: "INTERNAL_ERROR", message: "Unexpected server error", requestId } },
    { status: 500 },
  );
}

export function requestId(request: Request) {
  return request.headers.get("x-request-id") || crypto.randomUUID();
}
