import { appendFileSync } from "node:fs";

globalThis.fetch = async (url) => {
  const method = String(url).split("/").pop();
  if (process.env.MOCK_TELEGRAM_LOG) {
    appendFileSync(process.env.MOCK_TELEGRAM_LOG, `${method}\n`);
  }

  if (process.env.MOCK_TELEGRAM_NETWORK === "offline") {
    throw new Error("simulated offline network");
  }

  if (method === "getMe") {
    return json({ ok: true, result: { id: 101, username: "setup_test_bot" } });
  }
  if (method === "getChat") {
    if (process.env.MOCK_TELEGRAM_CHAT === "missing") {
      return json({ ok: false, description: "Bad Request: chat not found" });
    }
    return json({ ok: true, result: { id: -1001234567890, type: "supergroup", is_forum: true } });
  }
  if (method === "getChatMember") {
    const permissionMode = process.env.MOCK_TELEGRAM_PERMISSION || "complete";
    return json({
      ok: true,
      result: {
        status: "administrator",
        can_manage_topics: true,
        can_pin_messages: permissionMode !== "missing_pin",
        can_change_info: permissionMode !== "missing_change_info"
      }
    });
  }
  if (method === "getForumTopicIconStickers") {
    return json({ ok: true, result: [] });
  }

  return json({ ok: false, description: `Unexpected mutating call: ${method}` });
};

function json(body) {
  return {
    async json() {
      return body;
    }
  };
}
