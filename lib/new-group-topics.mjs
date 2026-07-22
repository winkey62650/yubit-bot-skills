export function selectNewGroupTopics(topics, selectedTopicIds) {
  const availableTopics = Array.isArray(topics) ? topics : [];
  const availableIds = availableTopics.map((topic, index) => normalizeId(topic?.id || index + 1));
  const duplicateAvailableId = availableIds.find((id, index) => availableIds.indexOf(id) !== index);
  if (duplicateAvailableId) throw new Error(`模板中存在重复的 Topic：${duplicateAvailableId}`);

  if (selectedTopicIds === undefined || selectedTopicIds === null) return availableTopics;
  if (!Array.isArray(selectedTopicIds)) throw new Error("Topic 选择格式无效");

  const selectedIds = selectedTopicIds.map(normalizeId).filter(Boolean);
  if (!selectedIds.length) throw new Error("至少选择一个 Topic");

  const duplicateSelectedId = selectedIds.find((id, index) => selectedIds.indexOf(id) !== index);
  if (duplicateSelectedId) throw new Error(`选择中存在重复的 Topic：${duplicateSelectedId}`);

  const availableIdSet = new Set(availableIds);
  const unknownId = selectedIds.find((id) => !availableIdSet.has(id));
  if (unknownId) throw new Error(`选择了不存在的 Topic：${unknownId}`);

  const selectedIdSet = new Set(selectedIds);
  return availableTopics.filter((topic, index) => selectedIdSet.has(availableIds[index]));
}

export function buildSelectedTopicTemplateJson(topics, selectedTopicIds) {
  return JSON.stringify(selectNewGroupTopics(topics, selectedTopicIds));
}

function normalizeId(value) {
  return String(value ?? "").trim();
}
