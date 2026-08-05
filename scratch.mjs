import { telegramMtprotoCall } from "./lib/telegram-mtproto.mjs";

async function test() {
  try {
    const dialogs = await telegramMtprotoCall(null, "getDialogs", { limit: 10 }, { userId: "yubit" });
    console.log("Groups:", dialogs.filter(d => d.isGroup || d.isChannel).map(d => d.title));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
test();
