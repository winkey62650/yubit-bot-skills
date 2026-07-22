import { siteService } from "@/lib/features/sites/site.service";
import { jsonError, jsonOk, requestId } from "@/lib/shared/http";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const id = requestId(request);
  try {
    return jsonOk(siteService.list());
  } catch (error) {
    return jsonError(error, id);
  }
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const body = await request.json();
    return jsonOk(siteService.create(body), { status: 201 });
  } catch (error) {
    return jsonError(error, id);
  }
}
