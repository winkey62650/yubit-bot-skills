import { jsonOk } from "@/lib/shared/http";

export const dynamic = "force-dynamic";

export function GET() {
  return jsonOk({ status: "ok", service: "agency-analytics", time: new Date().toISOString() });
}
