import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("distribution summaries stay neutral while live data is loading", () => {
  const page = source("app/distribution/page.jsx");
  assert.match(page, /loading\s*\?\s*"—"/);
  assert.match(page, /socialReadiness\.enabled/);
  assert.match(page, /socialReadiness\.stable/);
  assert.doesNotMatch(page, /socialReadiness\.enabledCount|socialReadiness\.stableCount/);
  assert.match(page, /approvedTargetCount/);
  assert.match(page, /自动发布固定先进入 Demo Academy/);
  assert.doesNotMatch(page, /当前生产白名单只允许 Demo Academy Forum/);
  assert.match(page, /自动发布验收路由（先发 DEMO Academy）/);
});

test("group status waits for saved groups and publisher state before enabling actions", () => {
  const page = source("app/group-config/page.jsx");
  assert.match(page, /groupsLoaded/);
  assert.match(page, /publisherLoaded/);
  assert.match(page, /!groupsLoaded\s*\|\|\s*busy/);
  assert.match(page, /normalizeDistributionGroupTopics/);

  const globalWarning = page.indexOf("发布桥最近一次投递失败");
  const groupCard = page.indexOf("function GroupCard");
  assert.ok(globalWarning >= 0 && globalWarning < groupCard, "publisher warning must be global, not repeated per group");
});

test("settings cannot overwrite cloud configuration before the initial load completes", () => {
  const page = source("app/settings/page.jsx");
  assert.match(page, /settingsLoaded/);
  assert.match(page, /if\s*\(!settingsLoaded\)\s*return/);
  assert.match(page, /disabled=\{!settingsLoaded\s*\|\|\s*saving\}/);
});

test("live capability and publisher pages expose an explicit loading state", () => {
  const bots = source("app/bots/page.jsx");
  const publisher = source("app/telegram-user-authorization/page.jsx");
  assert.match(bots, /hasLiveResult/);
  assert.match(publisher, /PUBLISHER_HEARTBEAT_STALE_MS/);
  assert.match(publisher, /staleAfterMs=\{PUBLISHER_HEARTBEAT_STALE_MS\}/);
  assert.match(publisher, /loading\s*\?\s*"正在核验"/);
});

test("the console shell prevents mobile horizontal clipping", () => {
  const shell = source("app/components/ConsoleShell.jsx");
  assert.match(shell, /overflow-x-hidden/);
  assert.match(shell, /max-w-full/);
});

test("trading destinations use semantic topics and block incomplete saves", () => {
  const page = source("app/trading/page.jsx");
  assert.match(page, /normalizeDistributionGroupTopics/);
  assert.doesNotMatch(page, /orderedDistributionTopics/);
  assert.match(page, /canSaveDestination/);
  assert.match(page, /disabled=\{busy\s*\|\|\s*disabled\}/);
  assert.match(page, /data\.logs\.slice\(0,\s*20\)/);
  assert.match(page, /显示全部/);
  assert.match(page, /className="mt-4 break-all text-xl font-black leading-tight"/);
});

test("paused monitoring is reported as historical instead of current", () => {
  const page = source("app/settings/page.jsx");
  assert.match(page, /monitoringPaused/);
  assert.match(page, /value=\{currentStatus\}/);
  assert.match(page, /监控未运行；最近一次真实消息已成功送达/);
  assert.match(page, /以下为最近一次检查结果/);
  assert.match(page, /历史正常/);
});

test("publisher closure is gated by every live health check", () => {
  const page = source("app/telegram-user-authorization/page.jsx");
  assert.match(page, /allChecksHealthy/);
  assert.match(page, /闭环待恢复/);
  assert.doesNotMatch(page, /tone=\{ready\s*\?\s*"green"\s*:\s*"amber"\}/);
});
