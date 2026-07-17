import { readFile } from "node:fs/promises";
import path from "node:path";

const ARTWORK_FILES = Object.freeze({
  events: "morning-market-brief-bg-v2.png",
  analysis: "daily-market-analysis.png",
  whale: "whale-alert-bg-v2.png"
});

const artworkCache = new Map();

export async function loadMediaCardArtwork(kind, options = {}) {
  const filename = ARTWORK_FILES[kind];
  if (!filename) return null;

  const templatesDir = options.templatesDir || path.join(process.cwd(), "public", "templates");
  const readFileImpl = options.readFileImpl || readFile;
  const cacheKey = options.readFileImpl || options.templatesDir ? null : filename;
  if (cacheKey && artworkCache.has(cacheKey)) return artworkCache.get(cacheKey);

  const bytes = await readFileImpl(path.join(templatesDir, filename));
  const artwork = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
  if (cacheKey) artworkCache.set(cacheKey, artwork);
  return artwork;
}

