import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { approvedMarketPosterTemplates } from "./market-poster-templates.mjs";

const ROOT = join(process.cwd(), "public", "templates", "market-intelligence");
const APPROVED = new Map(approvedMarketPosterTemplates().map((template) => [template.id, template]));

export async function loadMarketPosterArtwork(model) {
  const requested = model?.visualTemplate;
  const approved = APPROVED.get(String(requested?.id || ""));
  const file = String(requested?.file || "");
  if (!approved || approved.file !== file || approved.product !== requested?.product
      || requested?.canvas?.width !== approved.canvas.width || requested?.canvas?.height !== approved.canvas.height) {
    throw new Error("Market poster artwork is not approved.");
  }
  const bytes = await readFile(join(ROOT, file));
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
