import { getDistributionRepository } from "./distribution-repository.mjs";
import { decryptCredential, encryptCredential, parseEncryptionKey } from "./trading-crypto.mjs";

const META_KEY = "discord:credentials:v1";

async function repositoryFor(options = {}) {
  return options.repository ?? getDistributionRepository();
}

function encryptionKeyFor(options = {}) {
  const value = String(options.encryptionKey ?? process.env.DISCORD_CREDENTIALS_ENCRYPTION_KEY ?? "").trim();
  try {
    parseEncryptionKey(value);
    return value;
  } catch {
    throw new Error("DISCORD_CREDENTIALS_ENCRYPTION_KEY is missing or invalid");
  }
}

function normalizeBotToken(value) {
  return String(value || "").trim().replace(/^Bot\s+/i, "").trim();
}

function normalizeInput(input = {}) {
  const appId = String(input.appId || "").trim();
  const publicKey = String(input.publicKey || "").trim().toLowerCase();
  const botToken = normalizeBotToken(input.botToken);
  if (!/^\d{15,24}$/.test(appId)) throw new Error("Discord App ID is invalid");
  if (!/^[a-f0-9]{64}$/.test(publicKey)) throw new Error("Discord Public Key is invalid");
  return { appId, publicKey, botToken };
}

export async function saveDiscordCredentials(input, options = {}) {
  const repository = await repositoryFor(options);
  const existing = (await repository.getMeta(META_KEY)) || {};
  const normalized = normalizeInput(input);
  if (!normalized.botToken && !existing.botTokenEncrypted) {
    throw new Error("Discord Bot Token is required");
  }

  const saved = {
    appId: normalized.appId,
    publicKey: normalized.publicKey,
    botTokenEncrypted: normalized.botToken
      ? encryptCredential(normalized.botToken, encryptionKeyFor(options))
      : existing.botTokenEncrypted,
    updatedAt: new Date().toISOString(),
  };
  await repository.setMeta(META_KEY, saved);
  return getDiscordCredentialStatus({ repository });
}

export async function loadDiscordCredentials(options = {}) {
  const repository = await repositoryFor(options);
  const stored = (await repository.getMeta(META_KEY)) || {};
  if (!stored.appId || !stored.publicKey || !stored.botTokenEncrypted) {
    return { appId: "", publicKey: "", botToken: "" };
  }
  return {
    appId: String(stored.appId),
    publicKey: String(stored.publicKey),
    botToken: normalizeBotToken(decryptCredential(stored.botTokenEncrypted, encryptionKeyFor(options))),
  };
}

export async function getDiscordCredentialStatus(options = {}) {
  const repository = await repositoryFor(options);
  const stored = (await repository.getMeta(META_KEY)) || {};
  const tokenConfigured = Boolean(stored.botTokenEncrypted);
  return {
    configured: Boolean(stored.appId && stored.publicKey && tokenConfigured),
    appId: String(stored.appId || ""),
    publicKey: String(stored.publicKey || ""),
    publicKeyConfigured: Boolean(stored.publicKey),
    tokenConfigured,
    updatedAt: stored.updatedAt || null,
  };
}

export async function clearDiscordCredentials(options = {}) {
  const repository = await repositoryFor(options);
  await repository.setMeta(META_KEY, {});
  return getDiscordCredentialStatus({ repository });
}
