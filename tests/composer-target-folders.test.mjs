import assert from "node:assert/strict";
import test from "node:test";

import {
  applyComposerTargetFolder,
  normalizeComposerTargetFolder,
  normalizeComposerTargetFolders
} from "../lib/composer-target-folders.mjs";

test("composer target folders retain unique exact group and Topic destinations", () => {
  const folder = normalizeComposerTargetFolder({
    id: "daily-news",
    name: "每日资讯",
    targets: [
      { id: "-100123:42", groupTitle: "YUBIT 中文", topicTitle: "市场资讯" },
      { id: "-100123:42", groupTitle: "重复项", topicTitle: "重复项" },
      { id: "-100456:", groupTitle: "公告频道", topicTitle: "主频道" }
    ]
  });

  assert.deepEqual(folder, {
    id: "daily-news",
    name: "每日资讯",
    targets: [
      { id: "-100123:42", groupTitle: "YUBIT 中文", topicTitle: "市场资讯" },
      { id: "-100456:", groupTitle: "公告频道", topicTitle: "主频道" }
    ]
  });
});

test("composer target folders reject malformed destinations and empty folders", () => {
  assert.throws(
    () => normalizeComposerTargetFolder({ id: "bad", name: "错误", targets: [{ id: "-100123:0" }] }),
    /发送目标格式无效/
  );
  assert.throws(
    () => normalizeComposerTargetFolder({ id: "empty", name: "空文件夹", targets: [] }),
    /至少包含一个发送目标/
  );
});

test("applying a folder selects only currently writable destinations and reports stale ones", () => {
  const folder = normalizeComposerTargetFolder({
    id: "market",
    name: "市场群",
    targets: [
      { id: "-100123:42", groupTitle: "中文群", topicTitle: "行情" },
      { id: "-100456:7", groupTitle: "英文群", topicTitle: "Markets" }
    ]
  });

  assert.deepEqual(applyComposerTargetFolder(folder, ["-100123:42", "-100999:"]), {
    selectedTargetIds: ["-100123:42"],
    unavailableTargets: [
      { id: "-100456:7", groupTitle: "英文群", topicTitle: "Markets" }
    ]
  });
});

test("saved target folders ignore corrupt persisted entries instead of breaking the composer", () => {
  assert.deepEqual(normalizeComposerTargetFolders([
    { id: "valid", name: "有效", targets: [{ id: "-100123:42" }] },
    { id: "invalid", name: "损坏", targets: [] }
  ]), [
    { id: "valid", name: "有效", targets: [{ id: "-100123:42", groupTitle: "", topicTitle: "" }] }
  ]);
});
