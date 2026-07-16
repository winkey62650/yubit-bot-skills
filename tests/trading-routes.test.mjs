import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("SpeakerBot webhook is public only at its dedicated secret-verified route", async () => {
  const route = await readFile(new URL("../app/api/telegram/speaker-webhook/route.js", import.meta.url), "utf8");
  const middleware = await readFile(new URL("../middleware.js", import.meta.url), "utf8");
  assert.match(route, /x-telegram-bot-api-secret-token/i);
  assert.match(route, /verifySpeakerWebhookSecret/);
  assert.match(route, /processSpeakerTelegramUpdate/);
  assert.match(route, /import \{ after, NextResponse \} from ["']next\/server["']/);
  assert.match(route, /defer: after/);
  assert.match(route, /export const runtime = ["']nodejs["']/);
  assert.match(middleware, /\/api\/telegram\/speaker-webhook/);
  assert.doesNotMatch(middleware, /pathname\.startsWith\(["']\/api\/trading/);
});

test("trading reconciliation cron requires environment-isolated cron credentials and the PNL image route verifies a signed token", async () => {
  const cron = await readFile(new URL("../app/api/cron/trading-reconcile/route.js", import.meta.url), "utf8");
  const card = await readFile(new URL("../app/api/media/pnl-card/route.js", import.meta.url), "utf8");
  assert.match(cron, /cronSecretConfig\(process\.env\)/);
  assert.match(cron, /Bearer/);
  assert.match(cron, /runTradingReconciliation/);
  assert.match(card, /verifyPnlCardPayload/);
  assert.match(card, /process\.env\.PNL_CARD_SIGNING_SECRET/);
  assert.match(card, /new ImageResponse/);
  assert.match(card, /export const runtime = ["']nodejs["']/);
});

test("authenticated trading management routes expose safe operator actions and idempotent recovery", async () => {
  const dashboard = await readFile(new URL("../app/api/trading/route.js", import.meta.url), "utf8");
  const detail = await readFile(new URL("../app/api/trading/signals/[id]/route.js", import.meta.url), "utf8");
  const refresh = await readFile(new URL("../app/api/trading/signals/[id]/refresh/route.js", import.meta.url), "utf8");
  const retry = await readFile(new URL("../app/api/trading/deliveries/[id]/retry/route.js", import.meta.url), "utf8");
  const middleware = await readFile(new URL("../middleware.js", import.meta.url), "utf8");

  assert.match(dashboard, /export const dynamic = ["']force-dynamic["']/);
  for (const action of [
    "save-trader",
    "save-account",
    "verify-account",
    "save-destination",
    "verify-destination",
    "test-destination",
    "configure-webhook",
  ]) assert.match(dashboard, new RegExp(action));
  assert.match(dashboard, /操作成功|保存成功|验证/);
  assert.match(detail, /getTradingSignalDetail/);
  assert.match(refresh, /refreshTradingSignal/);
  assert.match(retry, /retryTradingDelivery/);
  assert.match(dashboard, /tradingErrorStatus/);
  assert.match(detail, /tradingErrorStatus/);
  assert.match(refresh, /tradingErrorStatus/);
  assert.match(retry, /tradingErrorStatus/);
  assert.doesNotMatch(middleware, /pathname\.startsWith\(["']\/api\/trading/);
});

test("trading system status exposes missing cron configuration and gates release readiness on infrastructure", async () => {
  const page = await readFile(new URL("../app/trading/page.jsx", import.meta.url), "utf8");
  assert.match(page, /定时密钥未配置/);
  assert.match(page, /health\.scheduler\?\.ok/);
  assert.match(page, /health\.database\?\.ok[\s\S]*speaker\.ok[\s\S]*health\.scheduler\?\.ok/);
});
