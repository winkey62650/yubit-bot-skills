import { getDistributionRepository } from "./lib/distribution-repository.mjs";
import { createTelegramUserSessionStore } from "./lib/telegram-user-session.mjs";


async function main() {
  const repository = await getDistributionRepository();
  const store = createTelegramUserSessionStore({
    repository,
    encryptionKey: process.env.TELEGRAM_USER_SESSION_ENCRYPTION_KEY
  });
  
  await store.clear("7278080199");
  console.log("Cleared corrupted session for user 7278080199.");
}

main().catch(console.error);
