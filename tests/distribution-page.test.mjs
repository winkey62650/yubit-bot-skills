import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(new URL("../app/distribution/page.jsx", import.meta.url), "utf8");

test("automatic publishing and Telegram broadcast keep separate rule selections", () => {
  assert.match(pageSource, /selectedAutomationRules/);
  assert.match(pageSource, /selectedBroadcastRules/);
  assert.match(pageSource, /reconcileRuleSelection/);
});

test("content sync clearly configures where the selected Bot or human account copies messages", () => {
  assert.match(pageSource, /\["broadcast", "内容同步"\]/);
  assert.match(pageSource, /新增内容同步规则/);
  assert.match(pageSource, /从哪里同步到哪里/);
  assert.match(pageSource, /ForwardBot 监听/);
  assert.match(pageSource, /@Serenity_Crypto/);
  assert.match(pageSource, /telegramForwardMode/);
  assert.match(pageSource, /转发发布身份/);
  assert.match(pageSource, /使用 ForwardBot/);
  assert.match(pageSource, /使用真人 TG 账号/);
  assert.match(pageSource, /ForwardBot 通过 Bot API 复制到目标 Topic/);
  assert.match(pageSource, /来源群 \/ 频道 \/ Topic/);
  assert.match(pageSource, /发布目标（Telegram Topic \/ Discord Channel，可多选）/);
  assert.match(pageSource, /Bot API 发布已启用/);
  assert.match(pageSource, /内容同步发布器/);
  assert.match(pageSource, /Forum 群必须选择具体来源 Topic/);
  assert.match(pageSource, /群必须填写 Thread ID/);
  assert.doesNotMatch(pageSource, /可监听整个群 \/ 频道/);
  assert.doesNotMatch(pageSource, /群留空表示监听整群/);
  assert.match(pageSource, /暂无内容同步规则/);
});

test("rule lists expose accessible selection and select-all controls", () => {
  assert.match(pageSource, /aria-label={`选择规则：\$\{rule\.name\}`}/);
  assert.match(pageSource, /aria-label="选择当前列表全部规则"/);
  assert.match(pageSource, /全选当前列表/);
  assert.match(pageSource, /清空选择/);
});

test("bulk deletion confirms the count and sends one delete-many request", () => {
  assert.match(pageSource, /删除已选（\{selectedCount\}）/);
  assert.match(pageSource, /确认删除已选的 \$\{ids\.length\} 条\$\{kindLabel\}/);
  assert.match(pageSource, /action: "delete-many", ids/);
  assert.match(pageSource, /failedBulkDeleteIds\(result\)/);
  assert.match(pageSource, /bulkDeleteNotice\(result\)/);
});

test("automatic publishing explains the official identity workflow and exact topic routing", () => {
  assert.match(pageSource, /顶部自动发布身份/);
  assert.match(pageSource, /生产 Worker 通过 Telegram Bot API 自动发布/);
  assert.match(pageSource, /SpeakerBot 通过 Bot API 发布到选定目标群/);
  assert.match(pageSource, /真人 TG 发布桥在线/);
  assert.match(pageSource, /服务器生成带指纹的定稿模板并排队/);
  assert.match(pageSource, /本机发布桥取得唯一租约，单实例领取/);
  assert.match(pageSource, /Telegram Desktop 以目标群官方身份逐步发送/);
  assert.match(pageSource, /每步回写检查点，完成后回写消息编号/);
  assert.match(pageSource, /唯一租约保证单实例发布/);
  assert.match(pageSource, /每一步发送后立即回写检查点/);
  assert.match(pageSource, /逐字发送，禁止翻译、摘要、改写、增删或重新排版/);
  assert.match(pageSource, /Daily Events → 3\. Market Events/);
  assert.match(pageSource, /Daily Analysis → 4\. Market Analysis - Crypto\/Stocks\/TradFi/);
  assert.match(pageSource, /Whale Signals → 6\. Smart Money Tracker/);
  assert.match(pageSource, /2 条 · 独立海报 \+ 独立英文正文/);
  assert.match(pageSource, /1 条 · 海报与 Caption 同一条消息/);
  assert.match(pageSource, /禁止出现 OKX fallback/);
  assert.match(pageSource, /英文；禁止出现 Data Source 和 Hashtag/);
  assert.match(pageSource, /实际发送必须与已定稿 payload 的 imageUrl、caption、text 逐字段一致/);
  assert.match(pageSource, /系统剪贴板一次性粘贴/);
  assert.match(pageSource, /禁止逐字输入/);
  assert.match(pageSource, /emoji、标点、空行/);
  assert.match(pageSource, /发布检查点/);
  assert.match(pageSource, /已回写 \$\{row\.publisherProgress\.length\} 步/);
});

test("queued desktop publishing is reported as waiting instead of a false failure", () => {
  assert.match(pageSource, /result\.result\?\.status === "queued"/);
  assert.match(pageSource, /result\.result\?\.message \|\| "内容已生成并排队，等待本机发布桥发送。"/);
  assert.doesNotMatch(pageSource, /result\.result\?\.status !== "success"/);
});

test("core distribution rules stay visible when optional page data fails to load", () => {
  assert.match(pageSource, /const overviewResponse = await fetch\("\/api\/distribution"/);
  assert.match(pageSource, /setData\(overview\);/);
  assert.match(pageSource, /Promise\.allSettled/);
  assert.doesNotMatch(pageSource, /\[overviewResponse, groupsResponse, socialResponse, savedSettings, savedPresets\] = await Promise\.all/);
});

test("desktop publisher status distinguishes online, stalled, degraded and offline states", () => {
  assert.match(pageSource, /operationalStatus === "stalled"/);
  assert.match(pageSource, /发布任务卡住/);
  assert.match(pageSource, /operationalStatus === "degraded"/);
  assert.match(pageSource, /发布桥异常/);
  assert.match(pageSource, /operationalReady/);
});
