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
