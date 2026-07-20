import { get, put } from "@vercel/blob";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function useBlobStorage() {
  // APP_RELEASE_SHA is written only by the dedicated-server deploy script.
  // A stale Blob token or backend flag must never make that server depend on
  // Vercel storage again.
  if (process.env.APP_RELEASE_SHA && !process.env.VERCEL) return false;

  const backend = String(process.env.JSON_STORE_BACKEND || "").trim().toLowerCase();
  if (backend === "local") return false;
  if (backend === "blob") return true;
  return Boolean(process.env.VERCEL || process.env.VERCEL_OIDC_TOKEN || process.env.BLOB_READ_WRITE_TOKEN);
}

function localPath(pathname) {
  const directory = String(process.env.JSON_STORE_DIRECTORY || "").trim();
  return join(directory || join(process.cwd(), ".runtime"), pathname);
}

export async function readJson(pathname, fallback) {
  if (useBlobStorage()) {
    return readBlobJson(pathname, fallback);
  }

  const path = localPath(pathname);
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readBlobJson(pathname, fallback, getBlob = get) {
  const result = await getBlob(pathname, { access: "private", useCache: false });
  if (!result) return fallback;
  const text = await new Response(result.stream).text();
  return JSON.parse(text);
}

export async function writeJson(pathname, value) {
  const content = JSON.stringify(value, null, 2);
  if (useBlobStorage()) {
    await put(pathname, content, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json"
    });
    return value;
  }

  const path = localPath(pathname);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return value;
}
