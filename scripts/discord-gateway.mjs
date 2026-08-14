import { createHash } from "node:crypto";

import {
  Client,
  Events,
  GatewayIntentBits,
} from "discord.js";

import { createDiscordGatewayRuntime } from "../lib/discord-gateway-runtime.mjs";
import { getDiscordGatewayRetryAt } from "../lib/discord-gateway-retry.mjs";
import {
  getDiscordCredentialStatus,
  loadDiscordCredentials,
} from "../lib/discord-credentials.mjs";
import { writeDiscordGatewayStatus } from "../lib/discord-service.mjs";

const credentialPollMs = 15_000;
let active = null;
let activeFingerprint = "";
let reconciling = false;
let stopping = false;
let retryNotBeforeMs = 0;
let retryFingerprint = "";

function createClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
}

async function stopActive(reason) {
  if (!active) return;
  const current = active;
  active = null;
  activeFingerprint = "";
  await current.runtime.shutdown(reason);
}

async function writeWaiting(lastError = null) {
  await writeDiscordGatewayStatus({
    state: "waiting",
    online: false,
    lastError,
  });
}

async function reconcileCredentials() {
  if (reconciling || stopping) return;
  reconciling = true;
  try {
    const status = await getDiscordCredentialStatus();
    if (!status.configured) {
      await stopActive("credentials-cleared");
      await writeWaiting();
      return;
    }

    const credentials = await loadDiscordCredentials();
    const fingerprint = createHash("sha256")
      .update(`${credentials.appId}:${credentials.botToken}`)
      .digest("hex");
    if (active && fingerprint === activeFingerprint) return;
    if (fingerprint !== retryFingerprint) {
      retryFingerprint = fingerprint;
      retryNotBeforeMs = 0;
    }
    if (Date.now() < retryNotBeforeMs) return;

    await stopActive("credentials-changed");
    const client = createClient();
    const runtime = createDiscordGatewayRuntime({ client, token: credentials.botToken });
    client.once(Events.ClientReady, runtime.handleReady);
    client.on(Events.MessageCreate, runtime.handleMessage);
    client.on(Events.Warn, runtime.handleWarn);
    client.on(Events.Error, runtime.handleError);
    active = { client, runtime };
    activeFingerprint = fingerprint;

    try {
      await client.login(credentials.botToken);
    } catch (error) {
      retryNotBeforeMs = getDiscordGatewayRetryAt(error).getTime();
      await runtime.handleError(error);
      await stopActive("login-failed");
      await writeWaiting(
        `${error?.message || "Discord Gateway login failed."} Next retry: ${new Date(retryNotBeforeMs).toISOString()}`,
      );
    }
  } catch (error) {
    await stopActive("credential-reconcile-failed");
    await writeWaiting(error?.message || "Discord credential loading failed.");
  } finally {
    reconciling = false;
  }
}

await reconcileCredentials();
const credentialTimer = setInterval(() => void reconcileCredentials(), credentialPollMs);

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(credentialTimer);
  await stopActive(signal);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
