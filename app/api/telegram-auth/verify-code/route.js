import { NextResponse } from "next/server";
import { Api, TelegramClient, sessions } from "teleproto";
import { createTelegramUserSessionStore } from "../../../../lib/telegram-user-session.mjs";
import { getDistributionRepository } from "../../../../lib/distribution-repository.mjs";

export async function POST(request) {
  try {
    const { phoneNumber, phoneCodeHash, phoneCode, session: tempSession } = await request.json();
    if (!phoneNumber || !phoneCodeHash || !phoneCode || !tempSession) {
      return NextResponse.json({ ok: false, error: "Missing required fields" }, { status: 400 });
    }

    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;
    const encryptionKey = process.env.TELEGRAM_USER_SESSION_ENCRYPTION_KEY;

    if (!Number.isSafeInteger(apiId) || !apiHash || !encryptionKey) {
      return NextResponse.json({ ok: false, error: "Server missing TELEGRAM_API_ID, TELEGRAM_API_HASH, or ENCRYPTION_KEY" }, { status: 500 });
    }

    const client = new TelegramClient(new sessions.StringSession(tempSession), apiId, apiHash, {
      connectionRetries: 5,
    });
    
    await client.connect();

    // 1. Sign in
    try {
      await client.invoke(new Api.auth.SignIn({
        phoneNumber,
        phoneCodeHash,
        phoneCode
      }));
    } catch (err) {
      if ((err.errorMessage && err.errorMessage === "SESSION_PASSWORD_NEEDED") || (err.message && err.message.includes("2FA is enabled"))) {
        return NextResponse.json({ ok: false, needsPassword: true, error: "此账号开启了二次验证 (2FA)，请输入密码。" }, { status: 400 });
      }
      throw err;
    }

    // 2. Fetch User Info
    const me = await client.getMe();
    
    // 3. Save to Distribution Store
    const repository = await getDistributionRepository();
    const store = createTelegramUserSessionStore({
      repository,
      encryptionKey
    });

    const finalSessionString = client.session.save();

    await store.save({
      session: finalSessionString,
      user: me,
      apiCredentials: { apiId, apiHash }
    });

    return NextResponse.json({ ok: true, user: { id: String(me.id), username: me.username } });
  } catch (error) {
    console.error("[verifyCode error]", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
