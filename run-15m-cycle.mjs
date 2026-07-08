import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const nodePath = process.execPath;
const chatId = process.env.TELEGRAM_CHAT_ID;
const traderToken = process.env.TRADER1_BOT_TOKEN;

if (!chatId || !traderToken) {
  throw new Error("TELEGRAM_CHAT_ID and TRADER1_BOT_TOKEN are required");
}

const jobs = [
  {
    name: "3. Futures Signals",
    script: "binance-futures-sma-signal.mjs",
    env: { TELEGRAM_THREAD_ID: "10", SYMBOL_LIMIT: "20", SEND_TELEGRAM: "true" }
  },
  {
    name: "4. TradFi Signals",
    script: "tradfi-market-signal.mjs",
    env: { TELEGRAM_THREAD_ID: "12", SEND_TELEGRAM: "true" }
  },
  {
    name: "5. Crypto News",
    script: "news-poster.mjs",
    env: { TELEGRAM_THREAD_ID: "14", NEWS_MODE: "crypto", NEWS_LIMIT: "4", SEND_TELEGRAM: "true" }
  },
  {
    name: "6. Stocks & TradFi News",
    script: "news-poster.mjs",
    env: { TELEGRAM_THREAD_ID: "16", NEWS_MODE: "tradfi", NEWS_LIMIT: "4", SEND_TELEGRAM: "true" }
  }
];

for (const job of jobs) {
  console.log(`\n=== ${job.name} ===`);
  try {
    await run(job);
  } catch (error) {
    console.error(`${job.name} skipped: ${error.message}`);
  }
  await sleep(2500);
}

async function run(job) {
  const env = {
    ...process.env,
    ...job.env,
    TELEGRAM_CHAT_ID: chatId,
    TELEGRAM_BOT_TOKEN: traderToken
  };

  const child = spawn(nodePath, [job.script], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const code = await new Promise((resolve) => child.on("close", resolve));
  if (stdout) console.log(stdout.trim());
  if (stderr) console.error(stderr.trim());
  if (code !== 0) throw new Error(`${job.name} failed with code ${code}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
