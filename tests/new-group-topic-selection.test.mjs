import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSelectedTopicTemplateJson, selectNewGroupTopics } from "../lib/new-group-topics.mjs";

const topics = [
  { id: "1", emoji: "❗️", name: "1. READ FIRST - DISCLAIMER", attribute: "关闭话题" },
  { id: "2", emoji: "⚡️", name: "2. CryptoGuy Trading Zone", attribute: "交流频道" },
  { id: "3", emoji: "📰", name: "3. Market Events", attribute: "关闭话题" }
];

test("new-group topic selection keeps template order and full selected topic content", () => {
  const selected = selectNewGroupTopics(topics, ["3", "1"]);

  assert.deepEqual(selected.map((topic) => topic.id), ["1", "3"]);
  assert.equal(selected[0].name, "1. READ FIRST - DISCLAIMER");
  assert.equal(selected[1].emoji, "📰");
  assert.equal(selected[1].attribute, "关闭话题");
});

test("legacy new-group requests without a selection still initialize every topic", () => {
  assert.deepEqual(selectNewGroupTopics(topics).map((topic) => topic.id), ["1", "2", "3"]);
});

test("new-group topic selection rejects empty, duplicate and unknown selections", () => {
  assert.throws(() => selectNewGroupTopics(topics, []), /至少选择一个 Topic/);
  assert.throws(() => selectNewGroupTopics(topics, ["1", "1"]), /重复的 Topic/);
  assert.throws(() => selectNewGroupTopics(topics, ["9"]), /不存在的 Topic/);
});

test("new-group API filters topics on the server before launching Telegram setup", () => {
  const route = readFileSync(new URL("../app/api/scripts/route.js", import.meta.url), "utf8");

  assert.match(route, /buildSelectedTopicTemplateJson\([\s\S]*?payload\.selectedTopicIds[\s\S]*?\)/);
  assert.match(route, /TOPIC_TEMPLATE_JSON:\s*selectedTopicTemplateJson/);
});

test("new-group API payload contains only selected Topics in canonical order", () => {
  const json = buildSelectedTopicTemplateJson(topics, ["3", "1"]);

  assert.deepEqual(JSON.parse(json).map((topic) => topic.id), ["1", "3"]);
  assert.throws(() => buildSelectedTopicTemplateJson(topics, []), /至少选择一个 Topic/);
});

test("new-group UI provides controlled Topic selection and submits stable IDs", () => {
  const page = readFileSync(new URL("../app/new-group/page.jsx", import.meta.url), "utf8");

  assert.match(page, /const \[selectedTopicIds, setSelectedTopicIds\]/);
  assert.match(page, /checked=\{selectedTopicIds\.includes\(String\(topic\[0\]\)\)\}/);
  assert.match(page, /selectedTopicIds,/);
  assert.match(page, /全选/);
  assert.match(page, /清空/);
  assert.match(page, /General Chat 为 Telegram 系统话题/);
});
