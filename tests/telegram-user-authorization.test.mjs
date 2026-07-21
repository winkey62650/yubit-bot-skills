import assert from "node:assert/strict";
import test from "node:test";
import { authorizeTelegramUser } from "../lib/telegram-user-authorization.mjs";

test("Telegram user authorization persists the resulting user session", async () => {
  const calls = [];
  const saved = [];
  const client = {
    session: { save: () => "authorized-session" },
    async start(callbacks) {
      calls.push("start");
      assert.equal(await callbacks.phoneNumber(), "+10000000000");
      assert.equal(await callbacks.phoneCode(), "12345");
      assert.equal(await callbacks.password(), "two-factor");
    },
    async checkAuthorization() { return true; },
    async getMe() {
      return { id: 901n, username: "Serenity_Crypto", firstName: "Serenity", bot: false };
    }
  };
  const store = {
    async save(value) {
      saved.push(value);
      return { authorized: true, username: value.user.username };
    }
  };

  const status = await authorizeTelegramUser({
    client,
    store,
    phoneNumber: async () => "+10000000000",
    phoneCode: async () => "12345",
    password: async () => "two-factor"
  });

  assert.deepEqual(calls, ["start"]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].session, "authorized-session");
  assert.equal(saved[0].user.username, "Serenity_Crypto");
  assert.deepEqual(status, { authorized: true, username: "Serenity_Crypto" });
});

test("Telegram user authorization fails closed when Telegram does not authorize the session", async () => {
  let persisted = false;
  const client = {
    session: { save: () => "unauthorized-session" },
    async start() {},
    async checkAuthorization() { return false; },
    async getMe() { throw new Error("must not be called"); }
  };

  await assert.rejects(
    () => authorizeTelegramUser({
      client,
      store: { async save() { persisted = true; } },
      phoneNumber: async () => "phone",
      phoneCode: async () => "code",
      password: async () => "password"
    }),
    (error) => error?.code === "TELEGRAM_USER_SESSION_UNAUTHORIZED"
  );
  assert.equal(persisted, false);
});

test("Telegram user authorization never persists an empty session", async () => {
  let persisted = false;
  const client = {
    session: { save: () => "" },
    async start() {},
    async checkAuthorization() { return true; },
    async getMe() { return { id: 901, username: "Serenity_Crypto", bot: false }; }
  };

  await assert.rejects(
    () => authorizeTelegramUser({
      client,
      store: { async save() { persisted = true; } },
      phoneNumber: async () => "phone",
      phoneCode: async () => "code",
      password: async () => "password"
    }),
    (error) => error?.code === "TELEGRAM_USER_SESSION_EMPTY"
  );
  assert.equal(persisted, false);
});
