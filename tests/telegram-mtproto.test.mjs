import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramMtprotoTransport } from "../lib/telegram-mtproto.mjs";

const CHAT_ID = "-1003710405969";

function fakeClientHarness() {
  const calls = [];
  const client = {
    async start(options) {
      calls.push({ kind: "start", options });
    },
    async getInputEntity(value) {
      calls.push({ kind: "entity", value });
      return { className: "InputPeerChannel", channelId: 3710405969n, accessHash: 22n };
    },
    async invoke(request) {
      calls.push({ kind: "invoke", request });
      if (request.className === "channels.GetSendAs") {
        return { peers: [{ peer: { channelId: 3710405969n } }] };
      }
      return { updates: [] };
    },
    async sendMessage(entity, options) {
      calls.push({ kind: "sendMessage", entity, options });
      return { id: 777 };
    }
  };
  return { calls, client };
}

test("MTProto sendMessage sends as Demo Academy inside the selected topic", async () => {
  const { calls, client } = fakeClientHarness();
  const transport = createTelegramMtprotoTransport({
    env: {
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "hash",
      DEMO_TELEGRAM_CHAT_ID: CHAT_ID
    },
    createClient: async () => client
  });

  const result = await transport("8951722203:token", "sendMessage", {
    chat_id: CHAT_ID,
    message_thread_id: 14,
    text: "Signal"
  });

  assert.deepEqual(result, { message_id: 777 });
  const send = calls.find((call) => call.kind === "sendMessage");
  assert.ok(send);
  assert.equal(send.options.message, "Signal");
  assert.equal(send.options.sendAs.channelId, 3710405969n);
  assert.equal(send.options.topMsgId, 14);
  assert.equal(send.options.replyTo, 14);
});

test("MTProto transport refuses a peer that Telegram does not permit as send-as", async () => {
  const { client } = fakeClientHarness();
  client.invoke = async (request) => {
    if (request.className === "channels.GetSendAs") return { peers: [] };
    return { updates: [] };
  };
  const transport = createTelegramMtprotoTransport({
    env: {
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "hash",
      DEMO_TELEGRAM_CHAT_ID: CHAT_ID
    },
    createClient: async () => client
  });

  await assert.rejects(
    () => transport("8951722203:token", "sendMessage", { chat_id: CHAT_ID, text: "Signal" }),
    (error) => error?.code === "TELEGRAM_GROUP_IDENTITY_NOT_ALLOWED"
  );
});

test("MTProto credentials are required before any connection is created", async () => {
  let created = 0;
  const transport = createTelegramMtprotoTransport({
    env: { DEMO_TELEGRAM_CHAT_ID: CHAT_ID },
    createClient: async () => { created += 1; }
  });

  await assert.rejects(
    () => transport("8951722203:token", "sendMessage", { chat_id: CHAT_ID, text: "Signal" }),
    (error) => error?.code === "TELEGRAM_GROUP_IDENTITY_NOT_CONFIGURED"
  );
  assert.equal(created, 0);
});
