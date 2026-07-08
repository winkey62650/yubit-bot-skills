import process from "node:process";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const threadId = Number(process.env.TELEGRAM_THREAD_ID || 8);
const mode = process.env.MOD_MODE || "verify";

const messages = {
  verify: `<b>UID Verification Format</b>

Please submit your UID in this format:
UID: your YUBIT UID
Source: Winkey

Mods will verify whether your UID belongs to the Winkey agent channel.

Do not post phone numbers, emails, IDs, passwords, or verification codes in public.`,
  rules: `<b>Community Safety Rules</b>

1. No spam, ads, referral flooding, or impersonation.
2. No guaranteed-profit claims or paid private signals.
3. Admins will never DM first or ask for passwords, verification codes, private keys, seed phrases, or remote-control access.
4. Market content is informational only and not investment advice.
5. Report suspicious users in the support topic.`,
  help: `<b>YUBIT Winkey Support</b>

For UID verification, use Topic 2.
For market discussion, use Topic 7.
For campaign questions, use Topic 8.
For suspicious users or fake support accounts, report them to a mod immediately.`
};

if (!token || !chatId) {
  throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");
}

const text = messages[mode] || messages.verify;
const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    message_thread_id: threadId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  })
});

const body = await response.json();
if (!body.ok) throw new Error(body.description || "Telegram sendMessage failed");
console.log(JSON.stringify({ ok: true, message_id: body.result.message_id, mode, threadId }, null, 2));
