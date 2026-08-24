import { NextResponse } from "next/server";

import {
  clearDiscordCredentials,
  saveDiscordCredentials,
} from "../../../lib/discord-credentials.mjs";
import {
  checkDiscordHealth,
  getDiscordStatus,
  initializeDiscordGuild,
  refreshDiscordDemoTemplate,
  sendDiscordManualPublish,
  sendDiscordTestMessage,
  updateDiscordSettings,
} from "../../../lib/discord-service.mjs";
import { publishDiscordTemplate } from "../../../lib/discord-template-publish.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStoreHeaders = {
  "Cache-Control": "no-store, max-age=0",
};

function json(payload, init = {}) {
  return NextResponse.json(payload, {
    ...init,
    headers: {
      ...noStoreHeaders,
      ...(init.headers || {}),
    },
  });
}

export async function GET() {
  try {
    const status = await getDiscordStatus();
    return json({ ok: true, ...status });
  } catch (error) {
    return json(
      { ok: false, error: error?.message || "Discord 状态读取失败。" },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const action = String(body?.action || "").trim();
    let result;
    let requireConnectedStatus = false;

    if (action === "credential-save") {
      const providedBotToken = String(body.botToken || "").trim();
      if (providedBotToken) {
        const validation = await getDiscordStatus({
          appId: body.appId,
          publicKey: body.publicKey,
          botToken: providedBotToken,
        });
        if (!validation.connected) {
          throw new Error(`Discord Bot Token 验证失败：${validation.error || "无法连接 Discord API"}`);
        }
      }
      result = {
        credentials: await saveDiscordCredentials({
          appId: body.appId,
          publicKey: body.publicKey,
          botToken: body.botToken,
        }),
      };
      requireConnectedStatus = true;
    } else if (action === "credential-clear") {
      result = { credentials: await clearDiscordCredentials() };
    } else if (action === "initialize") {
      const initialized = await initializeDiscordGuild({
        guildId: body.guildId,
        selectedTemplateKeys: body.templateKeys,
        selectedTemplateIds: body.templateIds,
        dryRun: body.dryRun === true,
        markAsDemo: body.markAsDemo === true,
      });
      result = { initialized };
    } else if (action === "template-refresh") {
      result = { demoTemplate: await refreshDiscordDemoTemplate({ guildId: body.guildId }) };
    } else if (action === "settings") {
      result = {
        settings: await updateDiscordSettings({
          demoGuildId: body.demoGuildId,
          syncEnabled: body.syncEnabled,
        }),
      };
    } else if (action === "health-check") {
      const health = await checkDiscordHealth();
      return json({ ok: true, result: { health } });
    } else if (action === "test-message") {
      result = {
        testMessage: await sendDiscordTestMessage(body.channelId, body.content),
      };
    } else if (action === "template-publish") {
      result = {
        templatePublish: await publishDiscordTemplate({
          contentType: body.contentType,
          channelIds: body.channelIds,
        }, {
          publicBaseUrl: new URL(request.url).origin,
        }),
      };
    } else if (action === "manual-publish" || action === "direct-publish") {
      result = {
        [action === "direct-publish" ? "directPublish" : "manualPublish"]: await sendDiscordManualPublish({
          channelIds: body.channelIds,
          content: body.content,
          imageUrl: body.imageUrl,
        }),
      };
    } else {
      return json({ ok: false, error: "不支持的 Discord 操作。" }, { status: 400 });
    }

    const status = await getDiscordStatus();
    if (requireConnectedStatus && !status.connected) {
      throw new Error(`Discord Bot Token 验证失败：${status.error || "无法连接 Discord API"}`);
    }
    return json({ ok: true, result, ...status });
  } catch (error) {
    return json(
      { ok: false, error: error?.message || "Discord 操作失败。" },
      { status: 400 },
    );
  }
}
