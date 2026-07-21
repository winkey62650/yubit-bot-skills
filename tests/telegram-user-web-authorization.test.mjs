import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramUserWebAuthorization } from "../lib/telegram-user-web-authorization.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("web authorization pauses for a Telegram code and persists credentials only after completion", async () => {
  const calls = [];
  const codeRequested = deferred();
  const client = {
    session: { save: () => "web-session" },
    async start(callbacks) {
      calls.push(["phone", await callbacks.phoneNumber()]);
      codeRequested.resolve();
      calls.push(["code", await callbacks.phoneCode(true)]);
      calls.push(["password", await callbacks.password("hint")]);
    },
    async checkAuthorization() { return true; },
    async getMe() { return { id: 901, username: "Serenity_Crypto", bot: false }; },
    async disconnect() { calls.push(["disconnect"]); }
  };
  const saved = [];
  const manager = createTelegramUserWebAuthorization({
    createClient: async (credentials) => {
      calls.push(["credentials", credentials]);
      return client;
    },
    store: { async save(value) { saved.push(value); return { authorized: true, username: "Serenity_Crypto" }; } },
    id: () => "flow-1"
  });

  const beginPromise = manager.begin({ apiId: "12345", apiHash: "private-hash", phoneNumber: "+10000000000" });
  await codeRequested.promise;
  const begun = await beginPromise;
  assert.deepEqual(begun, { flowId: "flow-1", step: "code", codeViaApp: true });
  assert.equal(saved.length, 0);

  const completed = await manager.complete({ flowId: "flow-1", phoneCode: "54321", password: "2fa-secret" });
  assert.equal(completed.authorized, true);
  assert.deepEqual(calls.find((item) => item[0] === "code"), ["code", "54321"]);
  assert.deepEqual(calls.find((item) => item[0] === "password"), ["password", "2fa-secret"]);
  assert.equal(saved[0].session, "web-session");
  assert.deepEqual(saved[0].apiCredentials, { apiId: 12345, apiHash: "private-hash" });
  assert.equal(calls.at(-1)[0], "disconnect");
});

test("web authorization rejects expired flows without echoing submitted secrets", async () => {
  const manager = createTelegramUserWebAuthorization({
    createClient: async () => { throw new Error("must not create"); },
    store: { async save() {} }
  });

  await assert.rejects(
    () => manager.complete({ flowId: "missing", phoneCode: "do-not-echo", password: "also-secret" }),
    (error) => error?.code === "TELEGRAM_USER_AUTH_FLOW_EXPIRED"
      && !String(error.message).includes("do-not-echo")
      && !String(error.message).includes("also-secret")
  );
});
