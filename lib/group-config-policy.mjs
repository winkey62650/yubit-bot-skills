export function resolveDiscoveredGroups(existingGroups, discoveredGroups) {
  const existing = Array.isArray(existingGroups) ? existingGroups : [];
  const discovered = Array.isArray(discoveredGroups) ? discoveredGroups : [];

  if (!discovered.length && existing.length) {
    return { groups: existing, preservedExisting: true };
  }

  const existingByChatId = new Map(existing.map((group) => [String(group?.chatId ?? ""), group]));
  const groups = discovered.map((group) => {
    const saved = existingByChatId.get(String(group?.chatId ?? ""));
    if (!saved) return group;

    const discoveredHasVerifiedTopics = (Array.isArray(group?.topics) ? group.topics : [])
      .some((topic) => topic?.verified !== false && Number(topic?.threadId ?? topic?.topicId) > 0);
    const savedHasVerifiedTopics = (Array.isArray(saved?.topics) ? saved.topics : [])
      .some((topic) => topic?.verified !== false && Number(topic?.threadId ?? topic?.topicId) > 0);

    return !discoveredHasVerifiedTopics && savedHasVerifiedTopics
      ? { ...group, topics: saved.topics }
      : group;
  });
  return { groups, preservedExisting: false };
}

export function removeTelegramGroupRecords(groupConfig = {}, registry = {}, chatIds = []) {
  const requestedIds = new Set((Array.isArray(chatIds) ? chatIds : [])
    .map((chatId) => String(chatId || "").trim())
    .filter(Boolean));
  const configGroups = Array.isArray(groupConfig?.groups) ? groupConfig.groups : [];
  const registryGroups = Array.isArray(registry?.groups) ? registry.groups : [];
  const removedConfigIds = configGroups
    .map((group) => String(group?.chatId || group?.id || "").trim())
    .filter((chatId) => requestedIds.has(chatId));
  const removedRegistryIds = registryGroups
    .map((group) => String(group?.chatId || group?.id || "").trim())
    .filter((chatId) => requestedIds.has(chatId));

  return {
    groupConfig: {
      ...groupConfig,
      groups: configGroups.filter((group) => !requestedIds.has(String(group?.chatId || group?.id || "").trim()))
    },
    registry: {
      ...registry,
      groups: registryGroups.filter((group) => !requestedIds.has(String(group?.chatId || group?.id || "").trim()))
    },
    removed: {
      groupConfig: [...new Set(removedConfigIds)],
      registry: [...new Set(removedRegistryIds)]
    }
  };
}
