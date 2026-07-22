import { analyticsService } from "@/lib/features/analytics/analytics.service";
import { jsonError, jsonOk, requestId } from "@/lib/shared/http";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const id = requestId(request);
  try {
    const url = new URL(request.url);
    return jsonOk(
      analyticsService.dashboard({
        range: url.searchParams.get("range"),
        site: url.searchParams.get("site"),
      }),
    );
  } catch (error) {
    return jsonError(error, id);
  }
}
