import { eventService } from "@/lib/features/events/event.service";
import { jsonError, jsonOk, requestId } from "@/lib/shared/http";

export const dynamic = "force-dynamic";

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin || "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export async function POST(request: Request) {
  const id = requestId(request);
  const origin = request.headers.get("origin");
  try {
    const data = eventService.capture(await request.json(), {
      origin,
      userAgent: request.headers.get("user-agent"),
    });
    const response = jsonOk(data, { status: 202 });
    for (const [key, value] of Object.entries(corsHeaders(origin))) response.headers.set(key, value);
    return response;
  } catch (error) {
    const response = jsonError(error, id);
    for (const [key, value] of Object.entries(corsHeaders(origin))) response.headers.set(key, value);
    return response;
  }
}
