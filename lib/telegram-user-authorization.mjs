function authorizationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function authorizeTelegramUser(options = {}) {
  const { client, store, phoneNumber, phoneCode, password, onError } = options;
  if (!client || typeof client.start !== "function" || typeof client.getMe !== "function") {
    throw new TypeError("Telegram client is required");
  }
  if (!store || typeof store.save !== "function") {
    throw new TypeError("Telegram user session store is required");
  }

  await client.start({ phoneNumber, phoneCode, password, onError });
  if (typeof client.checkAuthorization === "function" && !await client.checkAuthorization()) {
    throw authorizationError(
      "Telegram 用户账号授权没有完成。",
      "TELEGRAM_USER_SESSION_UNAUTHORIZED"
    );
  }

  const user = await client.getMe();
  const session = String(client.session?.save?.() || "").trim();
  if (!session) {
    throw authorizationError(
      "Telegram 未返回可持久化的用户会话。",
      "TELEGRAM_USER_SESSION_EMPTY"
    );
  }
  return store.save({ session, user });
}
