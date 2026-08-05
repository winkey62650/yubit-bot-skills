import { NextResponse } from "next/server";
import { Api, TelegramClient, sessions } from "teleproto";

export async function POST(request) {
  try {
    const { phoneNumber } = await request.json();
    if (!phoneNumber) {
      return NextResponse.json({ ok: false, error: "Missing phoneNumber" }, { status: 400 });
    }

    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;

    if (!Number.isSafeInteger(apiId) || !apiHash) {
      return NextResponse.json({ ok: false, error: "Server missing TELEGRAM_API_ID or TELEGRAM_API_HASH" }, { status: 500 });
    }

    const client = new TelegramClient(new sessions.StringSession(""), apiId, apiHash, {
      connectionRetries: 5,
    });
    
    await client.connect();

    const result = await client.invoke(new Api.auth.SendCode({
      phoneNumber,
      apiId,
      apiHash,
      settings: new Api.CodeSettings({
        allowFlashcall: false,
        currentNumber: true,
        allowAppHash: false,
      })
    }));

    const session = client.session.save();

    return NextResponse.json({
      ok: true,
      phoneCodeHash: result.phoneCodeHash,
      session,
      isCodeViaApp: result.type.className === "auth.SentCodeTypeApp"
    });
  } catch (error) {
    console.error("[sendCode error]", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
