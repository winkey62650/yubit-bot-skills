import { isAllowedManualCtaUrl } from "./manual-cta.mjs";

export const DESTINATION_CTA_META_KEY = "distribution:destination-cta:v1";

export function destinationCtaKey(target = {}) {
  if (target.platform === "discord" || target.channelId) {
    const channelId = String(target.channelId || "").trim();
    return channelId ? `discord:${channelId}` : "";
  }
  const chatId = String(target.chatId || "").trim();
  if (!chatId) return "";
  if (target.chatType === "channel") return `telegram:${chatId}:channel`;
  const threadId = Number(target.threadId);
  return Number.isInteger(threadId) && threadId > 0 ? `telegram:${chatId}:${threadId}` : "";
}

export function normalizeDestinationCta(input = {}) {
  const ctaText = String(input.ctaText ?? input.text ?? "").trim().slice(0, 500);
  const ctaUrl = String(input.ctaUrl ?? input.url ?? "").trim().slice(0, 2000);
  if (!isAllowedManualCtaUrl(ctaUrl)) throw new Error("CTA 链接必须使用 http 或 https。");
  const rawEnabled = input.ctaEnabled ?? input.enabled;
  const ctaEnabled = rawEnabled === true || (rawEnabled !== false && Boolean(ctaText || ctaUrl));
  return {
    platform: input.platform === "discord" || input.channelId ? "discord" : "telegram",
    chatId: input.chatId == null ? "" : String(input.chatId),
    chatType: input.chatType === "channel" ? "channel" : "supergroup",
    threadId: input.threadId == null || input.threadId === "" ? null : Number(input.threadId),
    guildId: input.guildId == null ? "" : String(input.guildId),
    channelId: input.channelId == null ? "" : String(input.channelId),
    groupName: String(input.groupName || input.guildName || ""),
    topicName: String(input.topicName || input.channelName || ""),
    ctaEnabled,
    ctaText,
    ctaUrl,
  };
}

export async function loadDestinationCtaRegistry(repository) {
  if (!repository?.getMeta) return {};
  const stored = await repository.getMeta(DESTINATION_CTA_META_KEY);
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
}

export async function saveDestinationCtaRegistry(repository, configs = []) {
  if (!repository?.setMeta) throw new Error("当前存储不支持频道 CTA 配置。");
  const registry = {};
  for (const input of Array.isArray(configs) ? configs : []) {
    const config = normalizeDestinationCta(input);
    const key = destinationCtaKey(config);
    if (!key) throw new Error("CTA 配置缺少有效的频道或 Topic。");
    registry[key] = config;
  }
  await repository.setMeta(DESTINATION_CTA_META_KEY, registry);
  return registry;
}

export async function hydrateDestinationCtas(repository, targets = []) {
  const registry = await loadDestinationCtaRegistry(repository);
  return (targets || []).map((target) => {
    const configured = registry[destinationCtaKey(target)];
    return configured ? { ...target, ...configured } : target;
  });
}
