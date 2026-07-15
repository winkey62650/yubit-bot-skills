import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkspaceState } from "../lib/workspace-state.mjs";

test("new-group draft keeps editable topics and safe group settings", () => {
  const state = normalizeWorkspaceState("new-group", {
    groupName: "  DEMO Academy  ",
    groupDescription: "  A saved description  ",
    chatId: "-1003710405969",
    botRole: "speaker",
    dryRun: false,
    topics: [{ id: "1", emoji: "⚠️", name: "1. READ FIRST - DISCLAIMER", attribute: "关闭话题", announcement: "notice" }]
  });

  assert.equal(state.groupName, "DEMO Academy");
  assert.equal(state.groupDescription, "A saved description");
  assert.equal(state.botRole, "speaker");
  assert.equal(state.dryRun, false);
  assert.equal(state.topics[0].name, "1. READ FIRST - DISCLAIMER");
});

test("workspace sections only keep their supported fields", () => {
  assert.deepEqual(normalizeWorkspaceState("news", { selected: ["CoinDesk", "CoinDesk", 42], sourceFilter: "RSS", secret: "drop" }), {
    selected: ["CoinDesk"],
    sourceFilter: "RSS"
  });
  assert.deepEqual(normalizeWorkspaceState("signals", { selected: ["Daily Analysis"] }), { selected: ["Daily Analysis"] });
  assert.throws(() => normalizeWorkspaceState("unknown", {}), /Unsupported workspace section/);
});
