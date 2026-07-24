import {
  Client,
  Events,
  GatewayIntentBits,
} from "discord.js";

import {
  relayDiscordMessage,
  writeDiscordGatewayHeartbeat,
} from "../lib/discord-gateway.mjs";

const token = String(process.env.DISCORD_BOT_TOKEN || "").trim();

if (!token) {
  console.error("[discord-gateway] DISCORD_BOT_TOKEN is not configured.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let heartbeatTimer;
let shuttingDown = false;

async function heartbeat(status = "online", extra = {}) {
  try {
    await writeDiscordGatewayHeartbeat({
      status,
      botUserId: client.user?.id || "",
      botUsername: client.user?.username || "",
      guildCount: client.guilds?.cache?.size || 0,
      ...extra,
    });
  } catch (error) {
    console.error("[discord-gateway] heartbeat failed:", error?.message || error);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(
    `[discord-gateway] connected as ${readyClient.user.username}; guilds=${readyClient.guilds.cache.size}`,
  );
  await heartbeat("online");
  heartbeatTimer = setInterval(() => {
    heartbeat("online");
  }, 30_000);
  heartbeatTimer.unref?.();
});

client.on(Events.MessageCreate, async (message) => {
  try {
    const result = await relayDiscordMessage(message);
    if (result?.relayed > 0) {
      console.log(
        `[discord-gateway] relayed source=${message.guildId}/${message.channelId}/${message.id} targets=${result.relayed}`,
      );
    }
  } catch (error) {
    console.error(
      `[discord-gateway] relay failed source=${message.guildId || "unknown"}/${message.channelId || "unknown"}:`,
      error?.message || error,
    );
  }
});

client.on(Events.Warn, (warning) => {
  console.warn("[discord-gateway] warning:", warning);
});

client.on(Events.Error, async (error) => {
  console.error("[discord-gateway] client error:", error?.message || error);
  await heartbeat("error", { error: error?.message || "Discord Gateway error" });
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await heartbeat("offline", { reason: signal });
  client.destroy();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

client.login(token).catch(async (error) => {
  console.error("[discord-gateway] login failed:", error?.message || error);
  await heartbeat("error", { error: error?.message || "Discord login failed" });
  process.exit(1);
});
