import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { approvedMarketPosterTemplates } from "./market-poster-templates.mjs";

const ROOT = join(process.cwd(), "public", "templates", "market-intelligence");
const APPROVED = new Map(approvedMarketPosterTemplates().map((template) => [template.id, template]));

export async function loadMarketPosterArtwork(model) {
  const requested = model?.visualTemplate;
  const approved = APPROVED.get(String(requested?.id || ""));
  const file = String(requested?.file || "");
  if (!approved || approved.product !== requested?.product
      || requested?.canvas?.width !== approved.canvas.width || requested?.canvas?.height !== approved.canvas.height) {
    throw new Error("Market poster artwork is not approved.");
  }
  if (approved.composition === "locked-master-fixed-field-overlay") {
    throw new Error("Market poster uses a locked master; use loadMarketPosterMaster.");
  }
  if (approved.file !== file) throw new Error("Market poster artwork is not approved.");
  const bytes = await readFile(join(ROOT, file));
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

export async function loadMarketPosterMaster(model) {
  const requested = model?.visualTemplate;
  const approved = APPROVED.get(String(requested?.id || ""));
  if (!approved || approved.composition !== "locked-master-fixed-field-overlay"
      || approved.version < 4 || approved.product !== requested?.product
      || requested?.file !== approved.file || requested?.sha256 !== approved.sha256
      || requested?.canvas?.width !== approved.canvas.width || requested?.canvas?.height !== approved.canvas.height) {
    throw new Error("Market poster master is not approved.");
  }
  const bytes = await readFile(join(ROOT, approved.file));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== approved.sha256) throw new Error("Market poster master hash mismatch.");
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
