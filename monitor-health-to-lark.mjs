import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";

const checks = [
  { name: "本地控制台", kind: "http", target: process.env.ADMIN_HEALTH_URL || "http://localhost:4173/admin-preview.html" },
  { name: "新闻脚本", kind: "node-check", target: "news-poster.mjs" },
  { name: "信号脚本", kind: "node-check", target: "run-15m-cycle.mjs" },
  { name: "新群初始化", kind: "node-check", target: "scripts/new-group-setup.mjs" },
  { name: "监控脚本", kind: "node-check", target: "monitor-health-to-lark.mjs" }
];

const intervalMs = Number(process.env.MONITOR_INTERVAL_MS || 5 * 60 * 1000);
const loop = process.env.MONITOR_LOOP === "true";

if (loop) {
  await runOnce();
  setInterval(() => {
    runOnce().catch((error) => console.error(error));
  }, intervalMs);
} else {
  await runOnce();
}

async function runOnce() {
  const startedAt = new Date();
  const results = [];
  for (const check of checks) {
    results.push(await runCheck(check));
  }
  const failed = results.filter((item) => !item.ok);
  const text = formatLarkText(startedAt, results);

  console.log(text);
  if (process.env.SEND_LARK === "true") {
    await sendToLark(text);
  }

  process.exitCode = failed.length ? 1 : 0;
}

async function runCheck(check) {
  const started = Date.now();
  try {
    if (check.kind === "http") {
      const response = await fetch(check.target, { signal: AbortSignal.timeout(5000) });
      return result(check, response.ok, `${response.status} ${response.statusText}`, started);
    }
    if (check.kind === "node-check") {
      if (!existsSync(check.target)) return result(check, false, "file not found", started);
      const nodeCheck = await runCommand(process.execPath, ["--check", check.target], 8000);
      return result(check, nodeCheck.code === 0, nodeCheck.stderr || nodeCheck.stdout || "syntax ok", started);
    }
    return result(check, false, `unknown check kind: ${check.kind}`, started);
  } catch (error) {
    return result(check, false, error.message, started);
  }
}

function result(check, ok, message, started) {
  return {
    name: check.name,
    target: check.target,
    ok,
    message,
    latencyMs: Date.now() - started
  };
}

function formatLarkText(startedAt, results) {
  const failed = results.filter((item) => !item.ok);
  const status = failed.length ? "异常" : "正常";
  const lines = [
    `YUBIT 程序监控：${status}`,
    `Time: ${startedAt.toISOString()}`,
    `Summary: ${results.length - failed.length}/${results.length} checks passed`,
    "",
    ...results.map((item) => `${item.ok ? "OK" : "FAIL"} ${item.name} · ${item.target} · ${item.latencyMs}ms · ${item.message}`)
  ];
  return lines.join("\n");
}

async function sendToLark(text) {
  const webhook = process.env.LARK_WEBHOOK_URL;
  if (!webhook) throw new Error("Missing LARK_WEBHOOK_URL");
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      msg_type: "text",
      content: { text }
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Lark webhook failed: ${response.status} ${body}`);
  console.log(`Lark webhook sent: ${body}`);
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: 124, stdout, stderr: `${stderr}\ncommand timeout`.trim() });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
