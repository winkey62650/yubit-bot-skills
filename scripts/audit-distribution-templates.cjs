const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const baseUrl = String(process.env.TEST_BASE_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
const username = process.env.TEST_USERNAME;
const password = process.env.TEST_PASSWORD;
const artifactDir = path.resolve(process.env.TEST_ARTIFACT_DIR || "artifacts/distribution-template-audit");

if (!username || !password) {
  throw new Error("TEST_USERNAME and TEST_PASSWORD are required");
}

fs.mkdirSync(artifactDir, { recursive: true });

const expected = [
  { value: "daily-events", kind: "events" },
  { value: "daily-analysis", kind: "analysis" },
  { value: "whale-signals", kind: "whale" }
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const login = await context.request.post(`${baseUrl}/api/auth/login`, {
    data: { username, password }
  });
  if (!login.ok()) throw new Error(`Login failed: HTTP ${login.status()}`);

  await page.goto(`${baseUrl}/distribution`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Telegram 成品" }).waitFor();

  const groups = await page.evaluate(async () => {
    const response = await fetch("/api/group-config", { cache: "no-store" });
    if (!response.ok) throw new Error(`group-config HTTP ${response.status}`);
    const payload = await response.json();
    return (payload.groups || []).map((group) => ({
      title: group.title,
      chatId: group.chatId,
      topics: (group.topics || []).map((topic) => ({ name: topic.name, threadId: topic.threadId }))
    }));
  });
  const rules = await page.evaluate(async () => {
    const response = await fetch("/api/distribution", { cache: "no-store" });
    if (!response.ok) throw new Error(`distribution HTTP ${response.status}`);
    const payload = await response.json();
    return (payload.rules || []).map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      name: rule.name,
      contentType: rule.contentType,
      enabled: rule.enabled,
      targets: rule.targets
    }));
  });

  const templates = [];
  for (const item of expected) {
    await page.getByLabel("内容模板").selectOption(item.value);
    const image = page.locator('img[alt*="Telegram 配图预览"]');
    await image.waitFor();
    await page.waitForFunction((kind) => {
      const element = document.querySelector('img[alt*="Telegram 配图预览"]');
      return element?.complete && element?.naturalWidth > 0 && element.src.includes(`kind=${kind}`);
    }, item.kind);
    const details = await image.evaluate((element) => ({
      alt: element.alt,
      src: element.src,
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight
    }));
    await image.screenshot({ path: path.join(artifactDir, `${item.value}.png`) });
    templates.push({ contentType: item.value, expectedKind: item.kind, ...details });
  }

  await page.screenshot({ path: path.join(artifactDir, "distribution-page.png"), fullPage: true });
  await browser.close();

  const report = { baseUrl, groups, rules, templates, consoleErrors };
  fs.writeFileSync(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
