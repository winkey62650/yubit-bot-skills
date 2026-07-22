import { siteService } from "@/lib/features/sites/site.service";
import { jsonError, jsonOk, requestId } from "@/lib/shared/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const requestIdentifier = requestId(request);
  try {
    const { id } = await context.params;
    return jsonOk(siteService.get(id));
  } catch (error) {
    return jsonError(error, requestIdentifier);
  }
}

export async function DELETE(request: Request, context: Context) {
  const requestIdentifier = requestId(request);
  try {
    const { id } = await context.params;
    siteService.archive(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return jsonError(error, requestIdentifier);
  }
}
