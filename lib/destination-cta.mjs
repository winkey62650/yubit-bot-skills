import { isAllowedManualCtaUrl } from "./manual-cta.mjs";

export const DESTINATION_CTA_META_KEY = "distribution:destination-cta:v1";

export function destinationCtaKey(target = {}) {
  if (target.platform === "discord" || target.channelId) {
    const guildId = String(target.guildId || "").trim();
    return guildId ? `discord:${guildId}` : "";
  }
  const chatId = String(target.chatId || "").trim();
  return chatId ? `telegram:${chatId}` : "";
}

export function normalizeDestinationCta(input = {}) {
  const hasUnifiedContent = Object.prototype.hasOwnProperty.call(input, "ctaContent")
    || Object.prototype.hasOwnProperty.call(input, "content");
  const ctaText = String(input.ctaText ?? input.text ?? "").trim().slice(0, 500);
  const ctaUrl = String(input.ctaUrl ?? input.url ?? "").trim().slice(0, 2000);
  if (!hasUnifiedContent && !isAllowedManualCtaUrl(ctaUrl)) throw new Error("CTA 链接必须使用 http 或 https。");
  const ctaContent = String(
    hasUnifiedContent ? (input.ctaContent ?? input.content ?? "") : [ctaText, ctaUrl].filter(Boolean).join("\n")
  ).trim().slice(0, 2500);
  const rawEnabled = input.ctaEnabled ?? input.enabled;
  const ctaEnabled = rawEnabled === true || (rawEnabled !== false && Boolean(ctaContent));
  const platform = input.platform === "discord" || input.channelId ? "discord" : "telegram";
  return {
    platform,
    chatId: input.chatId == null ? "" : String(input.chatId),
    chatType: input.chatType === "channel" ? "channel" : "supergroup",
    threadId: null,
    guildId: input.guildId == null ? "" : String(input.guildId),
    channelId: platform === "discord" ? "" : (input.channelId == null ? "" : String(input.channelId)),
    groupName: String(input.groupName || input.guildName || ""),
    topicName: "",
    ctaEnabled,
    ctaContent,
  };
}

export async function loadDestinationCtaRegistry(repository) {
  if (!repository?.getMeta) return {};
  const stored = await repository.getMeta(DESTINATION_CTA_META_KEY);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};

  const registry = {};
  const entries = Object.entries(stored).filter(([, value]) => value && typeof value === "object" && !Array.isArray(value));
  const add = ([storedKey, value]) => {
    const legacyTelegramMatch = String(storedKey).match(/^telegram:([^:]+)(?::(?:channel|\d+))?$/);
    const discordGuildId = String(value.guildId || "").trim();
    const candidate = legacyTelegramMatch
      ? { ...value, platform: "telegram", chatId: String(value.chatId || legacyTelegramMatch[1]), threadId: null, topicName: "" }
      : discordGuildId
        ? { ...value, platform: "discord", guildId: discordGuildId, channelId: "", threadId: null, topicName: "" }
      : value;
    const config = normalizeDestinationCta(candidate);
    const key = destinationCtaKey(config);
    if (key && !registry[key]) registry[key] = config;
  };

  // A group/server-level value saved by the new UI wins over any legacy Topic/Channel-level value.
  entries.filter(([key, value]) => /^telegram:[^:]+$/.test(key)
    || (String(key) === `discord:${String(value.guildId || "").trim()}` && !String(value.channelId || "").trim())).forEach(add);
  entries.filter(([key]) => /^telegram:[^:]+:(?:channel|\d+)$/.test(key)).forEach(add);
  entries.filter(([key, value]) => key.startsWith("discord:")
    && !(String(key) === `discord:${String(value.guildId || "").trim()}` && !String(value.channelId || "").trim())).forEach(add);
  return registry;
}

export async function saveDestinationCtaRegistry(repository, configs = []) {
  if (!repository?.setMeta) throw new Error("当前存储不支持频道 CTA 配置。");
  const registry = {};
  for (const input of Array.isArray(configs) ? configs : []) {
    const config = normalizeDestinationCta(input);
    const key = destinationCtaKey(config);
    if (!key) throw new Error("CTA 配置缺少有效的 Telegram 群组/频道或 Discord Server。");
    registry[key] = config;
  }
  await repository.setMeta(DESTINATION_CTA_META_KEY, registry);
  return registry;
}

export async function saveDestinationCtaConfig(repository, input = {}) {
  if (!repository?.getMeta || !repository?.setMeta) throw new Error("当前存储不支持频道 CTA 配置。");
  const config = normalizeDestinationCta(input);
  const key = destinationCtaKey(config);
  if (!key) throw new Error("CTA 配置缺少有效的 Telegram 群组/频道或 Discord Server。");
  const registry = await loadDestinationCtaRegistry(repository);
  registry[key] = config;
  await repository.setMeta(DESTINATION_CTA_META_KEY, registry);
  return registry;
}

export async function mergeDestinationCtaConfigs(repository, configs = []) {
  if (!repository?.getMeta || !repository?.setMeta) throw new Error("当前存储不支持频道 CTA 配置。");
  const registry = await loadDestinationCtaRegistry(repository);
  for (const input of Array.isArray(configs) ? configs : []) {
    const config = normalizeDestinationCta(input);
    const key = destinationCtaKey(config);
    if (!key) throw new Error("CTA 配置缺少有效的 Telegram 群组/频道或 Discord Server。");
    registry[key] = config;
  }
  await repository.setMeta(DESTINATION_CTA_META_KEY, registry);
  return loadDestinationCtaRegistry(repository);
}

export async function hydrateDestinationCtas(repository, targets = []) {
  const registry = await loadDestinationCtaRegistry(repository);
  return (targets || []).map((target) => {
    const configured = registry[destinationCtaKey(target)];
    const {
      ctaText: _legacyText,
      ctaUrl: _legacyUrl,
      ctaContent: _oldContent,
      ctaEnabled: _oldEnabled,
      ctaSource: _oldSource,
      ...targetWithoutCta
    } = target;
    if (!configured) {
      return targetWithoutCta;
    }
    return {
      ...targetWithoutCta,
      ctaEnabled: configured.ctaEnabled,
      ctaContent: configured.ctaContent,
      ctaSource: "destination-registry",
    };
  });
}

const MARKET_EVENT_JOBS = new Set(["crypto-daily", "weekly-calendar", "data-release-updates"]);

export function requireSavedMarketEventCtas(jobId, targets = []) {
  if (!MARKET_EVENT_JOBS.has(jobId)) return targets;
  const missing = (targets || []).some((target) => target?.ctaSource !== "destination-registry"
    || target?.ctaEnabled !== true
    || !String(target?.ctaContent || "").trim());
  if (missing) throw new Error("MARKET_EVENTS_DESTINATION_CTA_REQUIRED");
  return targets;
}
