export const CANONICAL_TOPIC_ROUTES = Object.freeze({
  "-1003710405969": Object.freeze([6, 18, 8, 10, 14, 16, 12]),
  "-1004378187866": Object.freeze([3, 22, 8, 11, 17, 19, 14])
});

export function topicSequence(value) {
  const normalized = String(value ?? "").replace(/^[^\p{L}\p{N}]+/gu, "");
  const match = normalized.match(/^(\d+)\s*[.、)]/);
  return match ? Number(match[1]) : null;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function repairCanonicalTopicRouting(document, options = {}) {
  const routes = options.routes ?? CANONICAL_TOPIC_ROUTES;
  let changed = false;
  const groups = (Array.isArray(document?.groups) ? document.groups : []).map((group) => {
    const chatId = String(group?.chatId ?? group?.id ?? "");
    const expectedThreadIds = routes[chatId];
    if (!expectedThreadIds) return group;

    const topics = (Array.isArray(group.topics) ? group.topics : []).map((topic) => {
      const sequence = topicSequence(topic.name ?? topic.title);
      const expectedThreadId = expectedThreadIds[sequence - 1];
      if (!expectedThreadId) return topic;
      const repaired = {
        ...topic,
        id: expectedThreadId,
        threadId: expectedThreadId,
        source: "telegram-confirmed",
        verified: true
      };
      if (!same(topic, repaired)) changed = true;
      return repaired;
    });

    const repairedGroup = {
      ...group,
      topics,
      detectedTopicThreadIds: [...expectedThreadIds],
      topicCoverage: {
        knownCount: topics.length,
        resolvedCount: topics.filter((topic) => Number(topic.threadId) > 0).length,
        detectedThreadCount: expectedThreadIds.length,
        complete: topics.length > 0 && topics.every((topic) => Number(topic.threadId) > 0)
      },
      source: "telegram-confirmed"
    };
    if (!same(group, repairedGroup)) changed = true;
    return repairedGroup;
  });

  return {
    changed,
    value: changed
      ? { ...document, groups, updatedAt: options.now ?? new Date().toISOString() }
      : document
  };
}
