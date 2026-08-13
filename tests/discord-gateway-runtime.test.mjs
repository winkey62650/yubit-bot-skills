import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createDiscordGatewayRuntime } from "../lib/discord-gateway-runtime.mjs";

function fixture(overrides = {}) {
  const calls = { heartbeats: [], relays: [], logs: [], destroyed: 0, cleared: [] };
  const client = {
    user: { id: "bot-1", username: "Academy" },
    guilds: { cache: { size: 2 } },
    destroy() { calls.destroyed += 1; },
  };
  const timer = { unref() {} };
  const runtime = createDiscordGatewayRuntime({
    client,
    token: "secret",
    writeHeartbeat: async (...args) => { calls.heartbeats.push(args); return {}; },
    relay: async (...args) => { calls.relays.push(args); return { delivered: 2, failed: 0 }; },
    setIntervalImpl: () => timer,
    clearIntervalImpl: (value) => calls.cleared.push(value),
    logger: {
      log: (...args) => calls.logs.push(["log", ...args]),
      warn: (...args) => calls.logs.push(["warn", ...args]),
      error: (...args) => calls.logs.push(["error", ...args]),
    },
    ...overrides,
  });
  return { runtime, calls, client, timer };
}

test("ready heartbeat receives the Discord client and runtime options", async () => {
  const { runtime, calls, client } = fixture();
  await runtime.handleReady(client);
  assert.equal(calls.heartbeats.length, 1);
  assert.equal(calls.heartbeats[0][0], client);
  assert.deepEqual(calls.heartbeats[0][1], { token: "secret", state: "ready" });
});

test("message relay receives the connected client and uses delivered result", async () => {
  const { runtime, calls, client } = fixture();
  const message = { id: "message-1", guildId: "guild-1", channelId: "channel-1" };
  const result = await runtime.handleMessage(message);
  assert.equal(result.delivered, 2);
  assert.deepEqual(calls.relays[0], [message, { client, token: "secret" }]);
  assert.match(calls.logs.flat().join(" "), /targets=2/);
});

test("runtime records errors and shuts down cleanly", async () => {
  const { runtime, calls, client, timer } = fixture();
  await runtime.handleReady(client);
  await runtime.handleError(new Error("socket failed"));
  await runtime.shutdown("SIGTERM");
  assert.equal(calls.heartbeats[1][1].state, "error");
  assert.match(String(calls.heartbeats[1][1].lastError), /socket failed/);
  assert.equal(calls.heartbeats[2][1].state, "offline");
  assert.equal(calls.destroyed, 1);
  assert.deepEqual(calls.cleared, [timer]);
});

test("Gateway supervisor waits for backend credentials and ignores legacy token env", () => {
  const script = readFileSync(
    new URL("../scripts/discord-gateway.mjs", import.meta.url),
    "utf8",
  );
  assert.match(script, /loadDiscordCredentials/);
  assert.match(
    script,
    /import \{ writeDiscordGatewayStatus \} from "\.\.\/lib\/discord-service\.mjs";/,
  );
  assert.match(script, /waiting/);
  assert.doesNotMatch(script, /DISCORD_BOT_TOKEN/);
  assert.doesNotMatch(script, /process\.exit\(1\)/);
});
