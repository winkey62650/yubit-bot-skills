const TARGET_ID_PATTERN = /^-?\d+:(?:[1-9]\d*)?$/;

export function normalizeComposerTargetFolder(folder) {
  const id = cleanText(folder?.id, 100);
  const name = cleanText(folder?.name, 60);
  if (!id) throw new Error("目标文件夹 ID 不能为空");
  if (!name) throw new Error("目标文件夹名称不能为空");

  const seen = new Set();
  const targets = [];
  for (const target of Array.isArray(folder?.targets) ? folder.targets : []) {
    const targetId = cleanText(target?.id, 100);
    if (!TARGET_ID_PATTERN.test(targetId)) throw new Error("发送目标格式无效");
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    targets.push({
      id: targetId,
      groupTitle: cleanText(target?.groupTitle, 120),
      topicTitle: cleanText(target?.topicTitle, 120)
    });
  }
  if (targets.length === 0) throw new Error("目标文件夹至少包含一个发送目标");
  if (targets.length > 100) throw new Error("单个目标文件夹最多包含 100 个发送目标");

  return { id, name, targets };
}

export function normalizeComposerTargetFolders(folders) {
  const normalized = [];
  const seen = new Set();
  for (const folder of Array.isArray(folders) ? folders : []) {
    try {
      const next = normalizeComposerTargetFolder(folder);
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      normalized.push(next);
    } catch {
      // Ignore a corrupt persisted record so one bad folder cannot block publishing.
    }
  }
  return normalized;
}

export function applyComposerTargetFolder(folder, availableTargetIds) {
  const normalized = normalizeComposerTargetFolder(folder);
  const available = new Set(Array.isArray(availableTargetIds) ? availableTargetIds : []);
  return {
    selectedTargetIds: normalized.targets.filter((target) => available.has(target.id)).map((target) => target.id),
    unavailableTargets: normalized.targets.filter((target) => !available.has(target.id))
  };
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}
