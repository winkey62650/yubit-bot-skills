import { getDatabase } from "@/lib/shared/database";
import { jsonError, jsonOk, requestId } from "@/lib/shared/http";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const id = requestId(request);
  try {
    getDatabase().prepare("SELECT 1 AS ready").get();
    return jsonOk({ status: "ready", checks: { database: "ok" } });
  } catch (error) {
    return jsonError(error, id);
  }
}
