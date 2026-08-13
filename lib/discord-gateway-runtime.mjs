import { relayDiscordMessage, writeDiscordGatewayHeartbeat } from "./discord-gateway.mjs";

function sourceLabel(message) {
  return `${message?.guildId || "unknown"}/${message?.channelId || "unknown"}/${message?.id || "unknown"}`;
}

export function createDiscordGatewayRuntime({
  client,
  token = "",
  relay = relayDiscordMessage,
  writeHeartbeat = writeDiscordGatewayHeartbeat,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  heartbeatIntervalMs = 30_000,
  logger = console,
} = {}) {
  let timer = null;
  let shuttingDown = false;

  async function heartbeat(state = "ready", extra = {}) {
    try {
      return await writeHeartbeat(client, { token, state, ...extra });
    } catch (error) {
      logger.error?.(`[discord-gateway] heartbeat failed: ${error?.message || error}`);
      return null;
    }
  }

  async function handleReady(readyClient = client) {
    logger.log?.(`[discord-gateway] ready as ${readyClient?.user?.tag || readyClient?.user?.username || "unknown"}`);
    await heartbeat("ready");
    timer = setIntervalImpl(() => void heartbeat("ready"), heartbeatIntervalMs);
    timer?.unref?.();
  }

  async function handleMessage(message) {
    try {
      const result = await relay(message, { client, token });
      if ((result?.delivered || 0) > 0) {
        logger.log?.(`[discord-gateway] relayed source=${sourceLabel(message)} targets=${result.delivered}`);
      }
      return result;
    } catch (error) {
      logger.error?.(`[discord-gateway] relay failed source=${sourceLabel(message)}: ${error?.message || error}`);
      await heartbeat("error", { lastError: error });
      return null;
    }
  }

  async function handleError(error) {
    logger.error?.(`[discord-gateway] client error: ${error?.message || error}`);
    await heartbeat("error", { lastError: error });
  }

  function handleWarn(warning) {
    logger.warn?.(`[discord-gateway] warning: ${warning}`);
  }

  async function shutdown(signal = "shutdown") {
    if (shuttingDown) return false;
    shuttingDown = true;
    if (timer) clearIntervalImpl(timer);
    logger.log?.(`[discord-gateway] stopping (${signal})`);
    await heartbeat("offline", { lastError: null });
    client?.destroy?.();
    return true;
  }

  return { heartbeat, handleReady, handleMessage, handleError, handleWarn, shutdown };
}
