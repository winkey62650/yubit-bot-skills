import test from "node:test";
import assert from "node:assert/strict";

import {
  clearDiscordCredentials,
  getDiscordCredentialStatus,
  loadDiscordCredentials,
  saveDiscordCredentials,
} from "../lib/discord-credentials.mjs";

const encryptionKey = "11".repeat(32);
const appId = "111111111111111111";
const publicKey = "a".repeat(64);

function createRepository() {
  const meta = new Map();
  return {
    meta,
    async getMeta(key) {
      return meta.get(key) ?? null;
    },
    async setMeta(key, value) {
      meta.set(key, structuredClone(value));
      return value;
    },
  };
}

test("Discord credentials are encrypted at rest and can be loaded server-side", async () => {
  const repository = createRepository();
  await saveDiscordCredentials(
    {
      appId,
      publicKey,
      botToken: "new-secret-token",
    },
    { repository, encryptionKey },
  );

  const stored = JSON.stringify([...repository.meta.values()]);
  assert.equal(stored.includes("new-secret-token"), false);
  assert.deepEqual(await loadDiscordCredentials({ repository, encryptionKey }), {
    appId,
    publicKey,
    botToken: "new-secret-token",
  });
});

test("Discord credentials tolerate the Bot authorization prefix copied with a token", async () => {
  const repository = createRepository();
  await saveDiscordCredentials(
    {
      appId,
      publicKey,
      botToken: "  Bot new-secret-token  ",
    },
    { repository, encryptionKey },
  );

  assert.equal(
    (await loadDiscordCredentials({ repository, encryptionKey })).botToken,
    "new-secret-token",
  );
});

test("credential status is safe for the browser and preserves an existing token", async () => {
  const repository = createRepository();
  await saveDiscordCredentials(
    {
      appId,
      publicKey,
      botToken: "new-secret-token",
    },
    { repository, encryptionKey },
  );
  await saveDiscordCredentials(
    {
      appId,
      publicKey,
      botToken: "",
    },
    { repository, encryptionKey },
  );

  const status = await getDiscordCredentialStatus({ repository });
  assert.equal(status.configured, true);
  assert.equal(
    status.publicKey,
    publicKey,
  );
  assert.equal(status.tokenConfigured, true);
  assert.equal(JSON.stringify(status).includes("new-secret-token"), false);
  assert.equal(
    (await loadDiscordCredentials({ repository, encryptionKey })).botToken,
    "new-secret-token",
  );
});

test("Discord credentials can be cleared", async () => {
  const repository = createRepository();
  await saveDiscordCredentials(
    {
      appId,
      publicKey,
      botToken: "new-secret-token",
    },
    { repository, encryptionKey },
  );
  await clearDiscordCredentials({ repository });

  assert.equal((await getDiscordCredentialStatus({ repository })).configured, false);
  assert.deepEqual(await loadDiscordCredentials({ repository, encryptionKey }), {
    appId: "",
    publicKey: "",
    botToken: "",
  });
});

test("saving a Discord token requires a valid server encryption key", async () => {
  const repository = createRepository();
  await assert.rejects(
    saveDiscordCredentials(
      {
        appId,
        publicKey,
        botToken: "new-secret-token",
      },
      { repository, encryptionKey: "invalid" },
    ),
    /DISCORD_CREDENTIALS_ENCRYPTION_KEY/,
  );
});
