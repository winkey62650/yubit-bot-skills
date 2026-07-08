const navItems = document.querySelectorAll(".nav-item");
const panels = document.querySelectorAll("[data-panel]");
const runBtn = document.querySelector("#runBtn");
const exportBtn = document.querySelector("#exportBtn");
const previewState = document.querySelector("#previewState");
const chatFeed = document.querySelector("#chatFeed");
const botConfigForm = document.querySelector("#botConfigForm");
const botSaveState = document.querySelector("#botSaveState");
const loadSampleBtn = document.querySelector("#loadSampleBtn");
const clearBotConfigBtn = document.querySelector("#clearBotConfigBtn");
const botConnectionState = document.querySelector("#botConnectionState");
const summaryBotToken = document.querySelector("#summaryBotToken");
const summaryBotId = document.querySelector("#summaryBotId");
const summaryBotUsername = document.querySelector("#summaryBotUsername");
const summaryGroupId = document.querySelector("#summaryGroupId");
const summaryEnvironment = document.querySelector("#summaryEnvironment");
const statusBotReady = document.querySelector("#statusBotReady");
const generateCommandBtn = document.querySelector("#generateCommandBtn");
const copyCommandBtn = document.querySelector("#copyCommandBtn");
const deployCommand = document.querySelector("#deployCommand");

const botConfigKey = "yubit-community-demo.bot-config";
const botTokenKey = "yubit-community-demo.bot-token-session";
const botFields = [
  "telegramBotId",
  "telegramBotUsername",
  "telegramGroupId",
  "telegramWebhookUrl",
  "botEnvironment",
  "botLanguage",
  "canPostAnnouncements",
  "canReplyFaq",
  "canModerateRisk",
  "requiresModApproval"
];

const demoMessages = [
  {
    type: "bot",
    name: "FAQ Bot · BOT",
    text: "新用户完成 KYC 后，可以在 #new-user-onboarding 查看首充教程。"
  },
  {
    type: "ai",
    name: "Beta Hedge · AI",
    text: "高波动时段请降低杠杆并预设止损。本提示不构成投资建议。"
  },
  {
    type: "mod",
    name: "Trading Mod",
    text: "AI 交易员观点已通过审核，禁止晒收益诱导和私聊带单。"
  },
  {
    type: "bot",
    name: "Campaign Bot · BOT",
    text: "今日任务：完成一笔合约交易后可参与活动抽奖，具体规则见公告。"
  }
];

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    navItems.forEach((nav) => nav.classList.remove("active"));
    item.classList.add("active");

    const target = item.dataset.view;
    const panel = document.querySelector(`[data-panel="${target}"]`);
    panel?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

runBtn.addEventListener("click", () => {
  previewState.textContent = "预演中";
  runBtn.disabled = true;
  runBtn.textContent = "正在预演";

  demoMessages.forEach((message, index) => {
    window.setTimeout(() => {
      chatFeed.appendChild(createMessage(message));
      chatFeed.scrollTop = chatFeed.scrollHeight;

      if (index === demoMessages.length - 1) {
        previewState.textContent = "预演完成";
        runBtn.disabled = false;
        runBtn.textContent = "重新预演";
      }
    }, 650 * (index + 1));
  });
});

exportBtn.addEventListener("click", async () => {
  const botAccess = readBotConfig();
  delete botAccess.telegramBotToken;

  const payload = {
    project: "YUBIT Community Console Demo",
    platform: "Telegram",
    botAccess,
    channels: [
      "announcements",
      "new-user-onboarding",
      "contract-lab",
      "campaign-room",
      "vip-desk",
      "feedback-support"
    ],
    officialBots: ["Welcome Bot", "Campaign Bot", "FAQ Bot", "Risk Guard"],
    mods: ["Lead Mod", "Support Mod", "Trading Mod", "Night Mod"],
    aiTraders: ["Alpha Scout", "Beta Hedge"],
    safety: ["Bot labels required", "AI disclaimer required", "Mod review for high-risk trading content"]
  };

  await navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
  exportBtn.textContent = "已复制 JSON";
  window.setTimeout(() => {
    exportBtn.textContent = "导出配置";
  }, 1600);
});

botConfigForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const config = readBotConfig();
  const configForStorage = { ...config };
  delete configForStorage.telegramBotToken;
  localStorage.setItem(botConfigKey, JSON.stringify(configForStorage));
  sessionStorage.setItem(botTokenKey, config.telegramBotToken || "");
  renderBotSummary(config);
  renderDeployCommand(config);
  botSaveState.textContent = "已保存";
  botSaveState.classList.add("saved");
});

loadSampleBtn.addEventListener("click", () => {
  writeBotConfig({
    telegramBotToken: "TELEGRAM_BOT_TOKEN_FROM_ENV",
    telegramBotId: "1234567890",
    telegramBotUsername: "@YUBIT_Community_Bot",
    telegramGroupId: "-1002288000000",
    telegramWebhookUrl: "https://api.yubit.example/tg/webhook",
    botEnvironment: "sandbox",
    botLanguage: "zh-CN",
    canPostAnnouncements: true,
    canReplyFaq: true,
    canModerateRisk: true,
    requiresModApproval: true
  });
  botSaveState.textContent = "示例待保存";
  botSaveState.classList.remove("saved");
  renderBotSummary(readBotConfig());
  renderDeployCommand(readBotConfig());
});

clearBotConfigBtn.addEventListener("click", () => {
  localStorage.removeItem(botConfigKey);
  sessionStorage.removeItem(botTokenKey);
  botConfigForm.reset();
  writeBotConfig({
    botEnvironment: "sandbox",
    botLanguage: "zh-CN",
    canPostAnnouncements: true,
    canReplyFaq: true,
    canModerateRisk: true,
    requiresModApproval: true
  });
  botSaveState.textContent = "未保存";
  botSaveState.classList.remove("saved");
  renderBotSummary(readBotConfig());
  renderDeployCommand(readBotConfig());
});

generateCommandBtn.addEventListener("click", () => {
  renderDeployCommand(readBotConfig());
  document.querySelector('[data-panel="groupSystem"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
});

copyCommandBtn.addEventListener("click", async () => {
  await navigator.clipboard?.writeText(deployCommand.textContent);
  copyCommandBtn.textContent = "已复制";
  window.setTimeout(() => {
    copyCommandBtn.textContent = "复制命令";
  }, 1600);
});

function createMessage(message) {
  const article = document.createElement("article");
  article.className = `message ${message.type}`;

  const name = document.createElement("span");
  name.textContent = message.name;

  const text = document.createElement("p");
  text.textContent = message.text;

  article.append(name, text);
  return article;
}

function readBotConfig() {
  const config = {};

  const tokenInput = document.querySelector("#telegramBotToken");
  config.telegramBotToken = tokenInput?.value.trim() || "";

  botFields.forEach((field) => {
    const input = document.querySelector(`#${field}`);
    if (!input) return;
    config[field] = input.type === "checkbox" ? input.checked : input.value.trim();
  });

  return config;
}

function writeBotConfig(config) {
  const tokenInput = document.querySelector("#telegramBotToken");
  if (tokenInput && config.telegramBotToken !== undefined) {
    tokenInput.value = config.telegramBotToken;
  }

  botFields.forEach((field) => {
    const input = document.querySelector(`#${field}`);
    if (!input || config[field] === undefined) return;

    if (input.type === "checkbox") {
      input.checked = Boolean(config[field]);
      return;
    }

    input.value = config[field];
  });
}

function renderBotSummary(config) {
  const hasToken = Boolean(config.telegramBotToken);
  const hasBotId = Boolean(config.telegramBotId);
  const hasGroupId = Boolean(config.telegramGroupId);
  const isReady = hasToken && hasBotId && hasGroupId;
  summaryBotToken.textContent = hasToken ? maskToken(config.telegramBotToken) : "未输入";
  summaryBotId.textContent = config.telegramBotId || "-";
  summaryBotUsername.textContent = config.telegramBotUsername || "-";
  summaryGroupId.textContent = config.telegramGroupId || "-";
  summaryEnvironment.textContent = environmentLabel(config.botEnvironment);
  botConnectionState.textContent = isReady ? "可部署" : "未完成";
  botConnectionState.classList.toggle("ready", isReady);
  statusBotReady.textContent = isReady ? "1" : "0";
}

function environmentLabel(value) {
  const labels = {
    sandbox: "Sandbox 测试群",
    staging: "Staging 预发布",
    production: "Production 正式群"
  };

  return labels[value] ?? labels.sandbox;
}

function bootBotConfig() {
  const saved = localStorage.getItem(botConfigKey);
  if (saved) {
    writeBotConfig({ ...JSON.parse(saved), telegramBotToken: sessionStorage.getItem(botTokenKey) || "" });
    botSaveState.textContent = "已保存";
    botSaveState.classList.add("saved");
  }

  renderBotSummary(readBotConfig());
  renderDeployCommand(readBotConfig());
}

function maskToken(token) {
  if (token.length <= 12) return "已输入";
  return `${token.slice(0, 6)}...${token.slice(-5)}`;
}

function renderDeployCommand(config) {
  const token = config.telegramBotToken || "你的bot_token";
  const chatId = config.telegramGroupId || "你的群ID";
  const nodePath = "/Users/winkey/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";
  const scriptPath = "/Users/winkey/Documents/Ai\\ Winkey/yubit-community-demo/setup-telegram-community.mjs";
  deployCommand.textContent = `TELEGRAM_BOT_TOKEN="${token}" TELEGRAM_CHAT_ID="${chatId}" DRY_RUN=false ${nodePath} ${scriptPath}`;
}

const observer = new IntersectionObserver(
  (entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

    if (!visible) return;
    const id = visible.target.dataset.panel;
    panels.forEach((panel) => panel.removeAttribute("aria-current"));
    visible.target.setAttribute("aria-current", "true");
    navItems.forEach((item) => item.classList.toggle("active", item.dataset.view === id));
  },
  { threshold: [0.35, 0.65] }
);

panels.forEach((panel) => observer.observe(panel));
bootBotConfig();
