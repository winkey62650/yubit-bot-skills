import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { updateJson, readJson } from "../../../../lib/json-store";
import {
  normalizeComposerTargetFolder,
  normalizeComposerTargetFolders
} from "../../../../lib/composer-target-folders.mjs";

export const dynamic = "force-dynamic";

const STORE_PATH = "composer/target-folders.json";
const EMPTY_STORE = { schemaVersion: 1, folders: [], updatedAt: null };

export async function GET() {
  const saved = await readJson(STORE_PATH, EMPTY_STORE);
  return NextResponse.json({
    ok: true,
    folders: normalizeComposerTargetFolders(saved?.folders),
    updatedAt: saved?.updatedAt || null
  });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const action = String(body.action || "save");
  try {
    const saved = await updateJson(STORE_PATH, (current) => {
      const folders = normalizeComposerTargetFolders(current?.folders);
      if (action === "delete") {
        const id = String(body.id || "").trim();
        if (!id) throw new Error("目标文件夹 ID 不能为空");
        return buildStore(folders.filter((folder) => folder.id !== id));
      }
      if (action !== "save") throw new Error("不支持的目标文件夹操作");

      const folder = normalizeComposerTargetFolder({
        ...body.folder,
        id: body.folder?.id || randomUUID()
      });
      const nextFolders = folders.filter((item) => item.id !== folder.id);
      nextFolders.push(folder);
      return buildStore(nextFolders);
    }, EMPTY_STORE);

    return NextResponse.json({
      ok: true,
      folders: normalizeComposerTargetFolders(saved.folders),
      updatedAt: saved.updatedAt
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message || "目标文件夹保存失败" }, { status: 400 });
  }
}

function buildStore(folders) {
  return { schemaVersion: 1, folders, updatedAt: new Date().toISOString() };
}
