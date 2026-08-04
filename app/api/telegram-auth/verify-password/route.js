import { NextResponse } from "next/server";
import { Api, TelegramClient, sessions } from "teleproto";
import { createTelegramUserSessionStore } from "../../../../lib/telegram-user-session.mjs";
import { getDistributionRepository } from "../../../../lib/distribution-repository.mjs";

export async function POST(request) {
  try {
    const { password, session: tempSession } = await request.json();
    if (!password || !tempSession) {
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

    // 1. Sign in with password
    try {
      await client.signInWithPassword(
        { apiId, apiHash }, 
        { 
          password: async () => password, 
          onError: async (e) => { throw e; }
        }
      );
    } catch (err) {
      return NextResponse.json({ ok: false, error: "密码错误或验证失败：" + (err.message || String(err)) }, { status: 400 });
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
    console.error("[verifyPassword error]", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
