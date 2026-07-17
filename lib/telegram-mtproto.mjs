import { Api, TelegramClient, sessions } from "teleproto";

const clients = new Map();

function configurationError() {
  const error = new Error(
    "Demo Academy 群身份发送缺少 TELEGRAM_API_ID 或 TELEGRAM_API_HASH。"
  );
  error.code = "TELEGRAM_GROUP_IDENTITY_NOT_CONFIGURED";
  return error;
}

function permissionError() {
  const error = new Error(
    "当前 Telegram Bot 无权代表 Demo Academy 发送，请确认它仍是启用匿名模式的群管理员。"
  );
  error.code = "TELEGRAM_GROUP_IDENTITY_NOT_ALLOWED";
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

function peerId(value) {
  const peer = value?.peer ?? value;
  const id = peer?.channelId ?? peer?.chatId ?? peer?.userId;
  return id == null ? "" : String(id);
}

function messageResult(message) {
  const id = number(message?.id ?? message?.messageId ?? message?.message_id);
  if (!id) throw new Error("Telegram MTProto did not return a message ID");
  return { message_id: id };
}

function commonOptions(payload, sendAs) {
  return {
    ...topicOptions(payload),
    sendAs,
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

function sessionForToken(env, botToken) {
  const botId = String(botToken || "").split(":", 1)[0];
  return String(env[`TELEGRAM_MTPROTO_SESSION_${botId}`] || env.TELEGRAM_MTPROTO_SESSION || "");
}

export function createTelegramMtprotoTransport(options = {}) {
  const env = options.env ?? process.env;
  const createClient = options.createClient ?? defaultCreateClient;
  const clientCache = options.clientCache ?? (options.createClient ? new Map() : clients);
  const permissionCache = new Set();

  async function getClient(botToken) {
    const apiId = Number(env.TELEGRAM_API_ID);
    const apiHash = String(env.TELEGRAM_API_HASH || "").trim();
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
      throw configurationError();
    }

    const cacheKey = `${apiId}:${String(botToken).split(":", 1)[0]}`;
    if (!clientCache.has(cacheKey)) {
      clientCache.set(cacheKey, (async () => {
        const client = await createClient({
          apiId,
          apiHash,
          botToken,
          session: sessionForToken(env, botToken)
        });
        await client.start({ botAuthToken: botToken });
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

  async function getAuthorizedPeer(client, botToken, targetChatId) {
    const peer = await client.getInputEntity(targetChatId);
    const key = `${String(botToken).split(":", 1)[0]}:${targetChatId}`;
    if (!permissionCache.has(key)) {
      const allowed = await client.invoke(new Api.channels.GetSendAs({ peer }));
      const targetId = peerId(peer);
      if (!allowed?.peers?.some((candidate) => peerId(candidate) === targetId)) {
        throw permissionError();
      }
      permissionCache.add(key);
    }
    return peer;
  }

  return async function telegramMtprotoCall(botToken, method, payload = {}) {
    const targetChatId = String(payload.chat_id || "").trim();
    if (!targetChatId) throw new TypeError("chat_id is required");
    const client = await getClient(botToken);
    const peer = await getAuthorizedPeer(client, botToken, targetChatId);
    const shared = commonOptions(payload, peer);

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
        sendAs: peer,
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

    const error = new Error(`Telegram group identity method is not supported: ${method}`);
    error.code = "TELEGRAM_GROUP_IDENTITY_METHOD_UNSUPPORTED";
    throw error;
  };
}

export const telegramMtprotoCall = createTelegramMtprotoTransport();
