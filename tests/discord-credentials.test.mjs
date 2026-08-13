import test from "node:test";
import assert from "node:assert/strict";

import {
  clearDiscordCredentials,
  getDiscordCredentialStatus,
  loadDiscordCredentials,
  saveDiscordCredentials,
} from "../lib/discord-credentials.mjs";

const encryptionKey = "11".repeat(32);

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
      appId: "1530060451705262151",
      publicKey: "bc88ef40090d4cb47bf169363c6ac53689840849954848e24252f2475135c4ff",
      botToken: "new-secret-token",
    },
    { repository, encryptionKey },
  );

  const stored = JSON.stringify([...repository.meta.values()]);
  assert.equal(stored.includes("new-secret-token"), false);
  assert.deepEqual(await loadDiscordCredentials({ repository, encryptionKey }), {
    appId: "1530060451705262151",
    publicKey: "bc88ef40090d4cb47bf169363c6ac53689840849954848e24252f2475135c4ff",
    botToken: "new-secret-token",
  });
});

test("credential status is safe for the browser and preserves an existing token", async () => {
  const repository = createRepository();
  await saveDiscordCredentials(
    {
      appId: "1530060451705262151",
      publicKey: "bc88ef40090d4cb47bf169363c6ac53689840849954848e24252f2475135c4ff",
      botToken: "new-secret-token",
    },
    { repository, encryptionKey },
  );
  await saveDiscordCredentials(
    {
      appId: "1530060451705262151",
      publicKey: "bc88ef40090d4cb47bf169363c6ac53689840849954848e24252f2475135c4ff",
      botToken: "",
    },
    { repository, encryptionKey },
  );

  const status = await getDiscordCredentialStatus({ repository });
  assert.equal(status.configured, true);
  assert.equal(
    status.publicKey,
    "bc88ef40090d4cb47bf169363c6ac53689840849954848e24252f2475135c4ff",
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
      appId: "1530060451705262151",
      publicKey: "bc88ef40090d4cb47bf169363c6ac53689840849954848e24252f2475135c4ff",
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
        appId: "1530060451705262151",
        publicKey: "bc88ef40090d4cb47bf169363c6ac53689840849954848e24252f2475135c4ff",
        botToken: "new-secret-token",
      },
      { repository, encryptionKey: "invalid" },
    ),
    /DISCORD_CREDENTIALS_ENCRYPTION_KEY/,
  );
});
