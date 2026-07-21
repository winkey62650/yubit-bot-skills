import { TelegramClient, sessions } from "teleproto";
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

function identityMismatchError(expected, actual) {
  const error = new Error(`Telegram 发布账号必须是 @${expected}，当前是 @${actual || "unknown"}。`);
  error.code = "TELEGRAM_USER_IDENTITY_MISMATCH";
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

async function defaultLoadSession(env) {
  const repository = await getDistributionRepository();
  return createTelegramUserSessionStore({
    repository,
    encryptionKey: env.TELEGRAM_USER_SESSION_ENCRYPTION_KEY,
    expectedUsername: env.TELEGRAM_USER_PUBLISHER_USERNAME || "Serenity_Crypto"
  }).load();
}

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@/, "");
}

export function createTelegramMtprotoTransport(options = {}) {
  const env = options.env ?? process.env;
  const createClient = options.createClient ?? defaultCreateClient;
  const loadSession = options.loadSession ?? (() => defaultLoadSession(env));
  const clientCache = options.clientCache ?? (options.createClient ? new Map() : clients);

  async function getClient() {
    const stored = await loadSession();
    const envApiId = Number(env.TELEGRAM_API_ID);
    const envApiHash = String(env.TELEGRAM_API_HASH || "").trim();
    const useEnvCredentials = Number.isSafeInteger(envApiId) && envApiId > 0 && envApiHash;
    const apiId = useEnvCredentials ? envApiId : Number(stored?.apiId);
    const apiHash = useEnvCredentials ? envApiHash : String(stored?.apiHash || "").trim();
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
      throw configurationError();
    }

    const expectedUsername = normalizeUsername(env.TELEGRAM_USER_PUBLISHER_USERNAME || "Serenity_Crypto");
    const cacheKey = `${apiId}:${expectedUsername.toLowerCase()}`;
    if (!clientCache.has(cacheKey)) {
      clientCache.set(cacheKey, (async () => {
        const client = await createClient({
          apiId,
          apiHash,
          session: stored?.session
        });
        await client.connect();
        if (!await client.checkAuthorization()) throw unauthorizedError();
        const me = await client.getMe();
        const actualUsername = normalizeUsername(me?.username);
        if (me?.bot || actualUsername.toLowerCase() !== expectedUsername.toLowerCase()) {
          throw identityMismatchError(expectedUsername, actualUsername);
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

  return async function telegramMtprotoCall(_botToken, method, payload = {}) {
    const targetChatId = String(payload.chat_id || "").trim();
    if (!targetChatId) throw new TypeError("chat_id is required");
    const client = await getClient();
    const peer = await client.getInputEntity(targetChatId);
    const shared = commonOptions(payload);

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
      const source = await client.getInputEntity(String(payload.from_chat_id));
      const ids = method === "copyMessages"
        ? (Array.isArray(payload.message_ids) ? payload.message_ids : [])
        : [payload.message_id];
      const messages = await client.forwardMessages(peer, {
        messages: ids.map(number).filter(Boolean),
        fromPeer: source,
        dropAuthor: true,
        topMsgId: shared.topMsgId,
        silent: shared.silent,
        noforwards: shared.noforwards
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
