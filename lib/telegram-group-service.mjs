import { existsSync, readFileSync } from "node:fs";
import { readJson, writeJson } from "./json-store.js";
import {
  collectTelegramChatCandidates,
  discoverTelegramChats,
  filterActiveTelegramGroups,
  mergeBotGroupDiscoveries,
  orderTopicsByTemplate,
  reconcileGroupWithSetupState
} from "./telegram-discovery.mjs";
import { defaultTopicTemplate, topicDisplayName } from "../templates.mjs";

const registryPath = "telegram-group-registry.json";

export const TELEGRAM_DISCOVERY_ALLOWED_UPDATES = Object.freeze([
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "my_chat_member"
]);

export async function probeGroupByChatId(chatId) {
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const botRoles = buildBotRoles(tokens);
  const verified = await verifyTelegramGroupByChatId(chatId, { botRoles, telegram });
  const expectedForumTopics = buildExpectedForumTopics();
  let group = verified.group;

  if (group.isForum) {
    try {
      const stateKey = `setup-states/${String(group.chatId).replace(/[^0-9-]/g, "")}.json`;
      const setupState = await readJson(stateKey, null);
      group = reconcileGroupWithSetupState(group, setupState, expectedForumTopics);
    } catch {
      // A missing setup state must not hide the live Telegram permission result.
    }
  }

  group = orderGroupTopics(group, expectedForumTopics);

  let warning = "";
  try {
    const registry = await readJson(registryPath, {});
    const groups = mergeSavedGroups(registry?.groups, [group]);
    await writeJson(registryPath, {
      schemaVersion: 1,
      groups: groups.map((item) => ({ ...item, lastSeenAt: item.chatId === group.chatId ? new Date().toISOString() : item.lastSeenAt })),
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    warning = `群检测成功，但登记结果暂时无法持久化：${error.message}`;
  }

  return {
    ...verified,
    group,
    groups: [group],
    warning,
    generatedAt: new Date().toISOString()
  };
}

export async function verifyTelegramGroupByChatId(chatId, options = {}) {
  const normalizedChatId = String(chatId || "").trim();
  if (!/^-100\d+$/.test(normalizedChatId)) {
    throw new Error("请输入有效的 Telegram 超级群或 Channel ID（以 -100 开头）");
  }

  const botRoles = options.botRoles || buildBotRoles();
  const telegramClient = options.telegram || telegram;
  const identities = await Promise.all(botRoles.map(async (bot) => {
    const checkedAt = new Date().toISOString();
    if (!bot.token) {
      return { ...bot, status: "未配置", username: "", apiAvailable: false, identityVerified: false, checkedAt, error: "Bot token 未配置" };
    }
    try {
      const me = await telegramClient(bot.token, "getMe", {});
      const username = me.result?.username || "";
      return {
        ...bot,
        botId: me.result?.id,
        username,
        status: username === bot.expectedUsername ? "在线" : "身份不匹配",
        apiAvailable: true,
        identityVerified: username === bot.expectedUsername,
        checkedAt
      };
    } catch (error) {
      return { ...bot, status: "需检查", username: "", apiAvailable: false, identityVerified: false, checkedAt, error: error.message };
    }
  }));

  const bots = await Promise.all(identities.map(async (identity) => {
    if (!identity.token || !identity.botId) return publicBot(identity, []);
    try {
      const discovery = await discoverTelegramChats({
        token: identity.token,
        botId: identity.botId,
        savedGroups: [{ chatId: normalizedChatId }],
        telegram: telegramClient
      });
      return publicBot(identity, discovery.groups);
    } catch (error) {
      return publicBot({ ...identity, status: "需检查", error: error.message }, []);
    }
  }));

  const groups = mergeBotGroupDiscoveries(bots, { expectedForumTopics: buildExpectedForumTopics() });
  const group = groups.find((item) => item.chatId === normalizedChatId) || null;
  if (!group || group.botCount === 0) {
    const reason = group?.bots?.map((bot) => bot.warning).find(Boolean)
      || bots.map((bot) => bot.error).find(Boolean)
      || "AdminBot 与后台能力组件均无法访问这个群";
    throw new Error(`群检测失败：${reason}`);
  }

  return { ok: true, bots, groups, group, source: "telegram-direct" };
}

export async function discoverCurrentBotGroups() {
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const botRoles = buildBotRoles(tokens);
  const [groupConfig, registry] = await Promise.all([
    readJson("group-config.json", {}),
    readJson(registryPath, {})
  ]);
  const savedGroups = mergeSavedGroups(groupConfig?.groups, registry?.groups);
  const probes = await Promise.all(botRoles.map(probeBot));
  const sharedCandidates = collectTelegramChatCandidates(
    probes.flatMap((probe) => probe.updates || []),
    savedGroups
  );

  const bots = await Promise.all(probes.map(async (probe) => {
    if (!probe.token || !probe.botId) return publicBot(probe, []);
    try {
      const discovery = await discoverTelegramChats({
        token: probe.token,
        botId: probe.botId,
        updates: [],
        savedGroups: sharedCandidates.active,
        telegram
      });
      return publicBot(probe, discovery.groups);
    } catch (error) {
      return publicBot({ ...probe, status: "需检查", error: error.message }, []);
    }
  }));
  const expectedForumTopics = buildExpectedForumTopics();
  // Telegram may keep old updates after every bot has left a chat. Do not let
  // those inaccessible candidates repopulate the persistent group registry.
  const discoveredGroups = filterActiveTelegramGroups(mergeBotGroupDiscoveries(bots, { expectedForumTopics }));
  const groups = await Promise.all(discoveredGroups.map(async (group) => {
    if (!group.isForum) return group;
    try {
      const stateKey = `setup-states/${String(group.chatId).replace(/[^0-9-]/g, "")}.json`;
      const setupState = await readJson(stateKey, null);
      return orderGroupTopics(reconcileGroupWithSetupState(group, setupState, expectedForumTopics), expectedForumTopics);
    } catch {
      return orderGroupTopics(group, expectedForumTopics);
    }
  }));
  let registryWarning = "";

  if (groups.length) {
    try {
      await writeJson(registryPath, {
        schemaVersion: 1,
        groups: groups.map((group) => ({ ...group, lastSeenAt: new Date().toISOString() })),
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      registryWarning = `群发现结果暂时无法持久化：${error.message}`;
    }
  }

  return {
    ok: true,
    bots,
    groups,
    migratedGroupsHidden: sharedCandidates.migrated.length,
    source: probes.some((probe) => (probe.updates || []).length) ? "telegram-live" : "saved-registry",
    warning: registryWarning || bots.map((bot) => bot.updateWarning).find(Boolean) || "",
    generatedAt: new Date().toISOString()
  };
}

function orderGroupTopics(group, expectedForumTopics) {
  if (!group || !Array.isArray(group.topics)) return group;
  return { ...group, topics: orderTopicsByTemplate(group.topics, expectedForumTopics) };
}

export function buildBotRoles(tokens = {}, env = process.env) {
  return [
    {
      name: "AdminBot",
      roleKey: "admin",
      role: "目标群发现 / Topic 初始化 / 权限复核",
      expectedUsername: "Bonnie_geniustrader_bot",
      token: tokens.YUBITADMIN_BOT_TOKEN || env.YUBITADMIN_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN
    },
    {
      name: "SpeakerBot",
      roleKey: "speaker",
      role: "Trader 私聊接收 / 订单核验",
      expectedUsername: "Satoshi_geniustrader_bot",
      token: tokens.SPEAKER_BOT_TOKEN || env.SPEAKER_BOT_TOKEN
    },
    {
      name: "ForwardBot",
      roleKey: "forward",
      role: "Telegram 来源监听 / 广播入站",
      expectedUsername: "Biupa_geniustrader_bot",
      token: tokens.FORWARD_BOT_TOKEN || env.FORWARD_BOT_TOKEN
    }
  ];
}

async function probeBot(bot) {
  const checkedAt = new Date().toISOString();
  if (!bot.token) return { ...bot, status: "未配置", username: "", apiAvailable: false, identityVerified: false, checkedAt, updates: [], error: "Bot token 未配置" };
  try {
    const me = await telegram(bot.token, "getMe", {});
    const username = me.result?.username || "";
    let updates = [];
    let updateWarning = "";
    let webhookInfo = null;
    try {
      const response = await telegram(bot.token, "getWebhookInfo", {});
      webhookInfo = response.result || null;
    } catch {
      // A failed webhook check must not make an otherwise healthy bot offline.
    }
    if (shouldPollTelegramUpdates(webhookInfo)) {
      try {
        const response = await telegram(bot.token, "getUpdates", {
          timeout: 0,
          limit: 100,
          allowed_updates: TELEGRAM_DISCOVERY_ALLOWED_UPDATES
        });
        updates = response.result || [];
      } catch (error) {
        updateWarning = error.message;
      }
    } else {
      updateWarning = "Webhook 已启用；群信息通过事件登记和权限复核更新。";
    }
    return {
      ...bot,
      botId: me.result?.id,
      username,
      status: username === bot.expectedUsername ? "在线" : "身份不匹配",
      apiAvailable: true,
      identityVerified: username === bot.expectedUsername,
      checkedAt,
      updates,
      updateWarning
    };
  } catch (error) {
    return { ...bot, status: "需检查", username: "", apiAvailable: false, identityVerified: false, checkedAt, updates: [], error: error.message };
  }
}

export function shouldPollTelegramUpdates(webhookInfo) {
  return !String(webhookInfo?.url || "").trim();
}

function publicBot(probe, groups) {
  return {
    name: probe.name,
    roleKey: probe.roleKey,
    role: probe.role,
    expectedUsername: probe.expectedUsername,
    username: probe.username || probe.expectedUsername,
    status: probe.status,
    apiAvailable: probe.apiAvailable ?? probe.status === "在线",
    identityVerified: probe.identityVerified ?? probe.status === "在线",
    checkedAt: probe.checkedAt || "",
    groups,
    updateWarning: probe.updateWarning || "",
    error: probe.error || ""
  };
}

function mergeSavedGroups(...sources) {
  const unique = new Map();
  for (const group of sources.flatMap((source) => Array.isArray(source) ? source : [])) {
    const chatId = String(group?.chatId || group?.id || "").trim();
    if (chatId) unique.set(chatId, { ...(unique.get(chatId) || {}), ...group, chatId });
  }
  return [...unique.values()];
}

function buildExpectedForumTopics() {
  return defaultTopicTemplate.map((topic) => ({
    id: String(topic.id || ""),
    name: topicDisplayName(topic),
    source: "template",
    verified: false
  }));
}

async function telegram(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json();
  if (!body.ok) throw new Error(body.description || `${method} failed`);
  return body;
}

function readTokenEnv(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}
