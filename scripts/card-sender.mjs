import { spawn } from "node:child_process";
import process from "node:process";

const kind = process.env.CARD_KIND || "futures";
const dryRun = process.env.DRY_RUN !== "false";

const scriptByKind = {
  futures: "binance-futures-sma-signal.mjs",
  tradfi: "tradfi-market-signal.mjs",
  news: "news-poster.mjs"
};

const script = scriptByKind[kind] || scriptByKind.futures;

console.log(
  JSON.stringify(
    {
      action: "card-sender",
      kind,
      dryRun,
      script,
      threadId: process.env.TELEGRAM_THREAD_ID || null
    },
    null,
    2
  )
);

const result = await run([script], {
  ...process.env,
  SEND_TELEGRAM: dryRun ? "false" : process.env.SEND_TELEGRAM || "true"
});

if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
process.exit(result.code);

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
