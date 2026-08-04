import { NextResponse } from "next/server";
import { TelegramClient, sessions } from "teleproto";
import { getDistributionRepository } from "../../../../lib/distribution-repository.mjs";
import { createTelegramUserSessionStore, telegramUserPublisherHealth } from "../../../../lib/telegram-user-session.mjs";
import { createTelegramUserWebAuthorization } from "../../../../lib/telegram-user-web-authorization.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const managerKey = Symbol.for("yubit.telegramUserWebAuthorization");

async function resources() {
  const repository = await getDistributionRepository();
  if (!globalThis[managerKey]) {
    const store = createTelegramUserSessionStore({
      repository,
      encryptionKey: process.env.TELEGRAM_USER_SESSION_ENCRYPTION_KEY,
      expectedUsername: process.env.TELEGRAM_USER_PUBLISHER_USERNAME || "Serenity_Crypto"
    });
    globalThis[managerKey] = createTelegramUserWebAuthorization({
      store,
      createClient: async ({ apiId, apiHash }) => new TelegramClient(
        new sessions.StringSession(""),
        apiId,
        apiHash,
        { connectionRetries: 5, autoReconnect: true }
      )
    });
  }
  return { repository, manager: globalThis[managerKey] };
}

export async function GET() {
  try {
    const { repository, manager } = await resources();
    const store = createTelegramUserSessionStore({
      repository,
      encryptionKey: process.env.TELEGRAM_USER_SESSION_ENCRYPTION_KEY
    });
    return NextResponse.json({
      ok: true,
      publisher: await telegramUserPublisherHealth({ repository }),
      accounts: await store.listAccounts(),
      authorization: manager.status()
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    const { repository, manager } = await resources();
    if (body.action === "begin") {
      return NextResponse.json({ ok: true, authorization: await manager.begin(body) });
    }
    if (body.action === "complete") {
      await manager.complete(body);
      const store = createTelegramUserSessionStore({
        repository,
        encryptionKey: process.env.TELEGRAM_USER_SESSION_ENCRYPTION_KEY
      });
      return NextResponse.json({
        ok: true,
        publisher: await telegramUserPublisherHealth({ repository }),
        accounts: await store.listAccounts(),
        authorization: manager.status()
      });
    }
    if (body.action === "cancel") {
      await manager.cancel(body.flowId);
      return NextResponse.json({ ok: true, authorization: manager.status() });
    }
    return NextResponse.json({ ok: false, error: "不支持的授权操作。" }, { status: 400 });
  } catch (error) {
    return failure(error);
  }
}

const safeErrors = new Map([
  ["TELEGRAM_USER_AUTH_INPUT_INVALID", [400, "API ID、API Hash 或国际格式手机号无效。"]],
  ["TELEGRAM_USER_AUTH_CODE_INVALID", [400, "Telegram 验证码格式无效。"]],
  ["TELEGRAM_USER_AUTH_FLOW_ACTIVE", [409, "已有一项 Telegram 授权正在进行。"]],
  ["TELEGRAM_USER_AUTH_FLOW_EXPIRED", [410, "授权已过期，请重新开始。"]],
  ["TELEGRAM_USER_AUTH_CONNECTION_FAILED", [503, "无法连接 Telegram 授权服务，请稍后重试。"]],
  ["TELEGRAM_USER_IDENTITY_MISMATCH", [403, "授权账号不是 @Serenity_Crypto，本次会话未保存。"]],
  ["TELEGRAM_USER_SESSION_NOT_CONFIGURED", [503, "服务器会话加密未就绪，请联系管理员。"]],
  ["TELEGRAM_USER_AUTH_REJECTED", [400, "Telegram 拒绝了本次授权，请重新开始并检查验证码。"]]
]);

function failure(error) {
  const [status, message] = safeErrors.get(String(error?.code || ""))
    || [503, "Telegram 用户授权暂时失败，请稍后重试。"];
  return NextResponse.json({ ok: false, error: message }, { status });
}
