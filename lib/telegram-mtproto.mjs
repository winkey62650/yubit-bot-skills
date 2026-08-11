import { Api, TelegramClient, sessions } from "teleproto";
import { getDistributionRepository } from "./distribution-repository.mjs";
import { createTelegramUserSessionStore } from "./telegram-user-session.mjs";

const clients = new Map();

function configurationError() {
  const error = new Error(
    "Telegram 用户发布器缺少 TELEGRAM_API_ID 或 TELEGRAM_API_HASH。"
  );
  error.code = "TELEGRAM_USER_PUBLISHER_NOT_CONFIGURED";
  return error;
}

function unauthorizedError() {
  const error = new Error("Telegram 用户会话已失效，请重新授权 @Serenity_Crypto。");
  error.code = "TELEGRAM_USER_SESSION_UNAUTHORIZED";
  return error;
}

// Identity mismatch error removed as we now support multiple dynamic accounts

function groupTargetRequiredError(targetChatId) {
  const error = new Error(
    `Telegram 官方群身份发布只支持 Group/Forum，目标 ${targetChatId} 不是超级群。`
  );
  error.code = "TELEGRAM_GROUP_TARGET_REQUIRED";
  return error;
}

function groupIdentityUnavailableError(targetChatId) {
  const error = new Error(
    `Telegram 未向当前账号开放目标群 ${targetChatId} 的官方群身份，请检查匿名管理员权限。`
  );
  error.code = "TELEGRAM_GROUP_IDENTITY_NOT_AVAILABLE";
  return error;
}

function parseMode(value) {
  const mode = String(value || "").toLowerCase();
  if (mode === "html") return "html";
  if (mode === "markdownv2") return "md2";
  if (mode === "markdown") return "md";
  return undefined;
}

function number(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function topicOptions(payload = {}) {
  const topMsgId = number(payload.message_thread_id);
  const explicitReply = number(payload.reply_parameters?.message_id);
  return {
    topMsgId,
    replyTo: explicitReply || topMsgId
  };
}

function messageResult(message) {
  const id = number(message?.id ?? message?.messageId ?? message?.message_id);
  if (!id) throw new Error("Telegram MTProto did not return a message ID");
  return { message_id: id };
}

function commonOptions(payload) {
  return {
    ...topicOptions(payload),
    silent: Boolean(payload.disable_notification),
    noforwards: Boolean(payload.protect_content),
    parseMode: parseMode(payload.parse_mode)
  };
}

async function defaultCreateClient({ apiId, apiHash, session }) {
  return new TelegramClient(
    new sessions.StringSession(session || ""),
    apiId,
    apiHash,
    { connectionRetries: 5, autoReconnect: true }
  );
}

async function defaultLoadSession(env, userId) {
  const repository = await getDistributionRepository();
  return createTelegramUserSessionStore({
    repository,
    encryptionKey: env.TELEGRAM_USER_SESSION_ENCRYPTION_KEY
  }).load(userId);
}

export function createTelegramSessionLoader(env, loader = defaultLoadSession) {
  return (userId) => loader(env, userId);
}

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@/, "");
}

function peerChannelId(value) {
  const channelId = value?.channelId ?? value?.channel_id;
  return channelId === undefined || channelId === null ? "" : String(channelId);
}

function telegramDialogChatId(dialog) {
  const rawId = String(dialog?.entity?.id ?? dialog?.id ?? "").trim();
  if (!rawId) return "";
  if (dialog?.isChannel || dialog?.entity?.megagroup === true) {
    return rawId.startsWith("-100") ? rawId : `-100${rawId.replace(/^-/, "")}`;
  }
  if (dialog?.isGroup) return rawId.startsWith("-") ? rawId : `-${rawId}`;
  return rawId;
}

function rightEnabled(rights, camelCase, snakeCase) {
  return rights?.[camelCase] === true || rights?.[snakeCase] === true;
}

function plainTextForbidden(rights) {
  return rightEnabled(rights, "sendMessages", "send_messages")
    || rightEnabled(rights, "sendPlain", "send_plain");
}

export function telegramEntityCanSendMessages(entity = {}, dialog = {}) {
  if (entity?.left === true || entity?.kicked === true || entity?.deactivated === true) {
    return false;
  }
  if (entity?.creator === true) return true;

  const adminRights = entity?.adminRights ?? entity?.admin_rights;
  const bannedRights = entity?.bannedRights ?? entity?.banned_rights;
  const defaultBannedRights = entity?.defaultBannedRights ?? entity?.default_banned_rights;

  if (entity?.broadcast === true) {
    return rightEnabled(adminRights, "postMessages", "post_messages");
  }
  if (plainTextForbidden(bannedRights)) return false;
  if (adminRights) return true;
  if (plainTextForbidden(defaultBannedRights)) return false;

  return dialog?.isGroup === true || entity?.megagroup === true;
}

export function telegramEntityCanManageTopics(entity = {}, dialog = {}) {
  if (entity?.left === true || entity?.kicked === true || entity?.deactivated === true) {
    return false;
  }
  if (entity?.creator === true) return true;

  const adminRights = entity?.adminRights
    ?? entity?.admin_rights
    ?? dialog?.adminRights
    ?? dialog?.admin_rights;
  return rightEnabled(adminRights, "manageTopics", "manage_topics");
}

async function resolveInputEntity(client, targetChatId) {
  try {
    return await client.getInputEntity(targetChatId);
  } catch (originalError) {
    const dialogs = await client.getDialogs({ limit: 500 });
    const dialog = dialogs.find((candidate) => telegramDialogChatId(candidate) === targetChatId);
    if (!dialog?.entity) throw originalError;
    return client.getInputEntity(dialog.entity);
  }
}

async function requireOfficialGroupIdentity(client, peer, targetChatId) {
  let available;
  try {
    available = await client.invoke(new Api.channels.GetSendAs({ peer }));
  } catch (cause) {
    const error = groupIdentityUnavailableError(targetChatId);
    error.cause = cause;
    throw error;
  }
  const targetChannelId = peerChannelId(peer);
  const canSendAsGroup = targetChannelId && (available?.peers || []).some(
    (candidate) => peerChannelId(candidate?.peer) === targetChannelId
  );
  if (!canSendAsGroup) throw groupIdentityUnavailableError(targetChatId);
  return peer;
}

export function createTelegramMtprotoTransport(options = {}) {
  const env = options.env ?? process.env;
  const createClient = options.createClient ?? defaultCreateClient;
  const loadSession = options.loadSession ?? createTelegramSessionLoader(env);
  const clientCache = options.clientCache ?? (options.createClient ? new Map() : clients);

  async function evictCachedClient(cacheKey) {
    const cached = clientCache.get(cacheKey);
    clientCache.delete(cacheKey);
    if (cached) {
      try {
        const client = await cached;
        await client.disconnect();
      } catch {
        // ignore disconnect errors
      }
    }
  }

  async function getClient(userId) {
    const stored = await loadSession(userId);
    const resolvedUserId = stored.userId || "default"; // Fallback if needed
    const envApiId = Number(env.TELEGRAM_API_ID);
    const envApiHash = String(env.TELEGRAM_API_HASH || "").trim();
    const useEnvCredentials = Number.isSafeInteger(envApiId) && envApiId > 0 && envApiHash;
    const apiId = useEnvCredentials ? envApiId : Number(stored?.apiId);
    const apiHash = useEnvCredentials ? envApiHash : String(stored?.apiHash || "").trim();
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
      throw configurationError();
    }

    const cacheKey = `${apiId}:${resolvedUserId}`;
    if (!clientCache.has(cacheKey)) {
      clientCache.set(cacheKey, (async () => {
        const client = await createClient({
          apiId,
          apiHash,
          session: stored?.session
        });
        try {
          await client.connect();
        } catch (err) {
          if (err.message && err.message.includes("SessionPasswordNeeded")) {
             try {
                const repository = await getDistributionRepository();
                const store = createTelegramUserSessionStore({
                  repository,
                  encryptionKey: env.TELEGRAM_USER_SESSION_ENCRYPTION_KEY
                });
                await store.clear(resolvedUserId);
             } catch (clearErr) {
                console.error("Failed to clear corrupted session:", clearErr);
             }
             const error = new Error("Telegram 会话因为需要 2FA 密码或已损坏而被清除，请重新登录。");
             error.code = "TELEGRAM_USER_SESSION_INVALID";
             throw error;
          }
          throw err;
        }
        if (!await client.checkAuthorization()) throw unauthorizedError();
        const me = await client.getMe();
        if (me?.bot) {
          throw new Error("Bot accounts are not supported for user sessions.");
        }
        // Watch for background errors from teleproto's UpdateManager (e.g. SessionPasswordNeededError)
        if (typeof client.on === "function") {
          client.on("error", async (err) => {
            if (err && String(err).includes("SessionPasswordNeeded")) {
              console.error(`[telegram-mtproto] Background session error for ${cacheKey}, evicting and clearing session:`, err.message);
              try {
                const repository = await getDistributionRepository();
                const store = createTelegramUserSessionStore({ repository, encryptionKey: env.TELEGRAM_USER_SESSION_ENCRYPTION_KEY });
                await store.clear(resolvedUserId);
              } catch (clearErr) {
                console.error("[telegram-mtproto] Failed to clear session:", clearErr);
              }
              await evictCachedClient(cacheKey);
            }
          });
        }
        return client;
      })());
    }
    try {
      return await clientCache.get(cacheKey);
    } catch (error) {
      clientCache.delete(cacheKey);
      throw error;
    }
  }

  return async function telegramMtprotoCall(_botToken, method, payload = {}, options = {}) {
    const targetChatId = String(payload.chat_id || "").trim();
    if (method !== "getDialogs" && !targetChatId) throw new TypeError("chat_id is required");
    const client = await getClient(options.userId);
    
    if (method === "getDialogs") {
      // Fetch all dialogs in batches (teleproto paginates automatically when limit is large)
      const dialogs = await client.getDialogs({ limit: 500 });
      return dialogs
        .filter(d => d.isGroup || d.isChannel)
        .map(d => {
          const rawId = String(d.entity?.id ?? "");
          // Supergroups and channels: teleproto returns positive IDs; Bot API uses -100+id format
          let chatId = rawId;
          if (d.isChannel || (d.entity?.megagroup === true)) {
            // Only prefix if not already prefixed
            if (!rawId.startsWith("-")) {
              chatId = `-100${rawId}`;
            }
          } else if (d.isGroup) {
            // Basic groups use negative ID directly
            if (!rawId.startsWith("-")) {
              chatId = `-${rawId}`;
            }
          }
          return {
            id: chatId,
            title: d.title || d.entity?.title || chatId,
            isGroup: d.isGroup,
            isChannel: d.isChannel,
            isForum: d.entity?.forum === true,
            type: d.entity?.megagroup === true ? "supergroup" : d.isChannel ? "channel" : "group",
            username: d.entity?.username || "",
            canSendMessages: telegramEntityCanSendMessages(d.entity, d),
            canManageTopics: telegramEntityCanManageTopics(d.entity, d)
          };
        });
    }

    const peer = await resolveInputEntity(client, targetChatId);
    const mapForumTopics = (topics) => (Array.isArray(topics) ? topics : []).map((topic) => {
      const deleted = topic?.className === "ForumTopicDeleted";
      const closed = topic?.closed === true;
      return {
        threadId: Number(topic?.id),
        name: topic?.title || "",
        closed,
        deleted,
        canSendMessages: !closed && !deleted
      };
    });
    if (method === "getForumTopics") {
      const response = await client.invoke(new Api.messages.GetForumTopics({
        peer,
        q: "",
        offsetDate: 0,
        offsetId: 0,
        offsetTopic: 0,
        limit: 100
      }));
      return mapForumTopics(response?.topics);
    }
    if (method === "getForumTopicsById") {
      const topicIds = [...new Set((Array.isArray(payload.thread_ids) ? payload.thread_ids : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0))];
      if (topicIds.length === 0) return [];
      const response = await client.invoke(new Api.messages.GetForumTopicsByID({
        peer,
        topics: topicIds
      }));
      return mapForumTopics(response?.topics);
    }
    if (method === "reopenForumTopic" || method === "closeForumTopic") {
      const topicId = Number(payload.message_thread_id ?? payload.thread_id);
      if (!Number.isInteger(topicId) || topicId <= 0) {
        throw new TypeError("message_thread_id is required");
      }
      const error = new Error("Topic 状态由群管理员维护，发布器不会自动开启或关闭 Topic。");
      error.code = "TELEGRAM_TOPIC_STATE_MUTATION_DISABLED";
      throw error;
    }
    const newContentMethods = new Set([
      "sendMessage",
      "sendPhoto",
      "sendVideo",
      "sendDocument",
      "sendAnimation",
      "sendAudio",
      "sendVoice",
      "sendMediaGroup",
      "copyMessage",
      "copyMessages"
    ]);
    let sendAs;
    if (newContentMethods.has(method)) {
      const entity = await client.getEntity(peer);
      if (entity?.broadcast === true) {
        // Telegram Channels publish with their native Channel identity.
        sendAs = undefined;
      } else if (entity?.megagroup === true) {
        sendAs = await requireOfficialGroupIdentity(client, peer, targetChatId);
      } else {
        throw groupTargetRequiredError(targetChatId);
      }
    }
    const shared = { ...commonOptions(payload), sendAs };



    if (method === "sendMessage") {
      return messageResult(await client.sendMessage(peer, {
        ...shared,
        message: String(payload.text || ""),
        linkPreview: !payload.disable_web_page_preview
      }));
    }

    if (["sendPhoto", "sendVideo", "sendDocument", "sendAnimation", "sendAudio", "sendVoice"].includes(method)) {
      const field = {
        sendPhoto: "photo",
        sendVideo: "video",
        sendDocument: "document",
        sendAnimation: "animation",
        sendAudio: "audio",
        sendVoice: "voice"
      }[method];
      return messageResult(await client.sendFile(peer, {
        ...shared,
        file: payload[field],
        caption: String(payload.caption || ""),
        forceDocument: method === "sendDocument",
        voiceNote: method === "sendVoice",
        supportsStreaming: method === "sendVideo"
      }));
    }

    if (method === "sendMediaGroup") {
      const media = Array.isArray(payload.media) ? payload.media : [];
      const messages = await client.sendFile(peer, {
        ...shared,
        file: media.map((item) => item.media),
        caption: media.map((item) => String(item.caption || ""))
      });
      return (Array.isArray(messages) ? messages : [messages]).map(messageResult);
    }

    if (method === "copyMessage" || method === "copyMessages") {
      const source = await resolveInputEntity(client, String(payload.from_chat_id));
      const ids = method === "copyMessages"
        ? (Array.isArray(payload.message_ids) ? payload.message_ids : [])
        : [payload.message_id];
      const messages = await client.forwardMessages(peer, {
        messages: ids.map(number).filter(Boolean),
        fromPeer: source,
        dropAuthor: true,
        topMsgId: shared.topMsgId,
        silent: shared.silent,
        noforwards: shared.noforwards,
        sendAs
      });
      const results = (Array.isArray(messages) ? messages : [messages]).map(messageResult);
      return method === "copyMessage" ? results[0] : results;
    }

    if (method === "editMessageText" || method === "editMessageCaption") {
      return messageResult(await client.editMessage(peer, {
        message: number(payload.message_id),
        text: String(method === "editMessageText" ? payload.text || "" : payload.caption || ""),
        parseMode: shared.parseMode,
        linkPreview: !payload.disable_web_page_preview
      }));
    }

    if (method === "editMessageMedia") {
      return messageResult(await client.editMessage(peer, {
        message: number(payload.message_id),
        file: payload.media?.media,
        text: String(payload.media?.caption || ""),
        parseMode: parseMode(payload.media?.parse_mode)
      }));
    }

    const error = new Error(`Telegram user publisher method is not supported: ${method}`);
    error.code = "TELEGRAM_USER_PUBLISHER_METHOD_UNSUPPORTED";
    throw error;
  };
}

export const telegramMtprotoCall = createTelegramMtprotoTransport();
