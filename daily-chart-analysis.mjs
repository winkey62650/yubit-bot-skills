import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const cwd = fileURLToPath(new URL(".", import.meta.url));
const shouldSend = process.env.SEND_TELEGRAM === "true";
const symbols = process.env.CHART_SYMBOLS || process.env.SYMBOLS || "BTCUSDT,ETHUSDT";
const interval = process.env.CHART_INTERVAL || process.env.BINANCE_INTERVAL || "1h";

const jobs = [
  {
    name: "BTC/ETH Chart Analysis",
    script: "binance-futures-sma-signal.mjs",
    env: {
      SYMBOLS: symbols,
      BINANCE_INTERVAL: interval,
      SYMBOL_LIMIT: "2",
      SEND_TELEGRAM: shouldSend ? "true" : "false"
    }
  },
  {
    name: "US Stocks Chart Analysis",
    script: "tradfi-market-signal.mjs",
    env: {
      SEND_TELEGRAM: shouldSend ? "true" : "false"
    }
  }
];

const outputs = [];

for (const job of jobs) {
  outputs.push(`\n<b>${job.name}</b>`);
  const result = await run(job);
  if (result.stdout) outputs.push(result.stdout.trim());
  if (result.stderr) outputs.push(result.stderr.trim());
  if (result.code !== 0) throw new Error(`${job.name} failed with code ${result.code}`);
  await sleep(1500);
}

console.log(outputs.join("\n\n").trim());

function run(job) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [job.script], {
      cwd,
      env: { ...process.env, ...job.env },
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
