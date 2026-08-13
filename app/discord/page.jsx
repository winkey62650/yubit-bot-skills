"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import ConsoleShell from "../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../components/ui";

const CHANNEL_TEMPLATES = [
  { id: 1, label: "1. READ FIRST - DISCLAIMER", name: "1-read-first-disclaimer" },
  { id: 2, label: "2. CryptoGuy Trading Zone", name: "2-cryptoguy-trading-zone" },
  { id: 3, label: "3. Market Events", name: "3-market-events" },
  { id: 4, label: "4. Market Analysis - Crypto/Stocks/TradFi", name: "4-market-analysis" },
  { id: 5, label: "5. Community Signal", name: "5-community-signal" },
  { id: 6, label: "6. Smart Money Tracker", name: "6-smart-money-tracker" },
  { id: 7, label: "7. YUBIT Updates", name: "7-yubit-updates" },
];

const initialStatus = {
  configured: false,
  connected: false,
  credentials: {
    configured: false,
    appId: "",
    publicKey: "",
    publicKeyConfigured: false,
    tokenConfigured: false,
    updatedAt: null,
  },
  installUrl: "",
  bot: null,
  guilds: [],
  config: { guilds: {}, routes: [], demoGuildId: "", syncEnabled: false },
  gateway: null,
};

function formatTime(value) {
  if (!value) return "尚无心跳";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚无心跳";
  return date.toLocaleString("zh-CN", { hour12: false });
}

export default function DiscordCommunityPage() {
  const [status, setStatus] = useState(initialStatus);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [guildId, setGuildId] = useState("");
  const [selectedTemplateIds, setSelectedTemplateIds] = useState(
    CHANNEL_TEMPLATES.map((template) => template.id),
  );
  const [markAsDemo, setMarkAsDemo] = useState(false);
  const [demoGuildId, setDemoGuildId] = useState("");
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [testChannelId, setTestChannelId] = useState("");
  const [testContent, setTestContent] = useState("Discord workflow test · delivery verified");
  const [appId, setAppId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [botToken, setBotToken] = useState("");
  const [manualChannelIds, setManualChannelIds] = useState([]);
  const [manualContent, setManualContent] = useState("");
  const [manualImageUrl, setManualImageUrl] = useState("");
  const [manualResults, setManualResults] = useState([]);

  const applyStatus = useCallback((payload) => {
    const next = {
      ...initialStatus,
      ...payload,
      config: {
        ...initialStatus.config,
        ...(payload?.config || {}),
      },
      credentials: {
        ...initialStatus.credentials,
        ...(payload?.credentials || {}),
      },
    };
    setStatus(next);
    setGuildId((current) => current || next.guilds?.[0]?.id || "");
    setDemoGuildId(next.config.demoGuildId || "");
    setSyncEnabled(next.config.syncEnabled === true);
    setAppId(next.credentials.appId || "");
    setPublicKey(next.credentials.publicKey || "");
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setError("");
      const response = await fetch("/api/discord", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Discord 状态读取失败。");
      }
      applyStatus(payload);
    } catch (requestError) {
      setError(requestError.message || "Discord 状态读取失败。");
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const initializedGuilds = useMemo(
    () => Object.values(status.config.guilds || {}).sort(
      (left, right) => String(left.guildName).localeCompare(String(right.guildName)),
    ),
    [status.config.guilds],
  );

  const selectedGuild = useMemo(
    () => status.guilds.find((guild) => String(guild.id) === String(guildId)),
    [guildId, status.guilds],
  );

  const routes = status.config.routes || [];

  useEffect(() => {
    if (testChannelId) return;
    const firstChannel = initializedGuilds
      .flatMap((guild) => guild.channels || [])
      .find((channel) => channel.channelId);
    if (firstChannel) setTestChannelId(firstChannel.channelId);
  }, [initializedGuilds, testChannelId]);

  async function runAction(action, body, successMessage) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/discord", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Discord 操作失败。");
      }
      applyStatus(payload);
      setNotice(successMessage);
      return payload.result;
    } catch (requestError) {
      setError(requestError.message || "Discord 操作失败。");
      return null;
    } finally {
      setBusy("");
    }
  }

  function toggleTemplate(templateId) {
    setSelectedTemplateIds((current) => (
      current.includes(templateId)
        ? current.filter((id) => id !== templateId)
        : [...current, templateId].sort((left, right) => left - right)
    ));
  }

  async function initialize(dryRun) {
    if (!guildId) {
      setError("请先选择一个 Discord Server。");
      return;
    }
    if (!selectedTemplateIds.length) {
      setError("请至少选择一个频道模板。");
      return;
    }
    const result = await runAction(
      "initialize",
      { guildId, templateIds: selectedTemplateIds, dryRun, markAsDemo },
      dryRun ? "初始化预览已生成，尚未修改 Discord Server。" : "频道初始化完成。",
    );
    if (dryRun && result?.initialized?.plan) {
      const createCount = result.initialized.plan.channels
        .filter((channel) => channel.action === "create").length;
      const reuseCount = result.initialized.plan.channels.length - createCount;
      setNotice(`初始化预览：将新建 ${createCount} 个频道，复用 ${reuseCount} 个频道。`);
    }
  }

  async function saveCredentials() {
    const result = await runAction(
      "credential-save",
      { appId, publicKey, botToken },
      "Discord Bot 凭证已安全保存，Gateway 将自动连接。",
    );
    if (result) setBotToken("");
  }

  async function clearCredentials() {
    if (!window.confirm("确认清除服务器保存的 Discord Bot 凭证？")) return;
    const result = await runAction(
      "credential-clear",
      {},
      "Discord Bot 凭证已清除，Gateway 已进入等待状态。",
    );
    if (result) setBotToken("");
  }

  async function saveSettings() {
    await runAction(
      "settings",
      { demoGuildId, syncEnabled },
      "Demo Server 与同步开关已保存。",
    );
  }

  async function sendTestMessage() {
    if (!testChannelId.trim()) {
      setError("请选择测试频道。");
      return;
    }
    await runAction(
      "test-message",
      { channelId: testChannelId.trim(), content: testContent },
      "测试消息已发送。",
    );
  }

  function toggleManualChannel(channelId) {
    setManualChannelIds((current) => (
      current.includes(channelId)
        ? current.filter((id) => id !== channelId)
        : [...current, channelId]
    ));
  }

  function getManualTarget(channelId) {
    for (const guild of initializedGuilds) {
      const channel = (guild.channels || []).find((item) => item.channelId === channelId);
      if (channel) return `${guild.guildName} / #${channel.name}`;
    }
    return channelId;
  }

  async function sendManualMessage() {
    if (!manualChannelIds.length) {
      setError("请至少选择一个发布频道。");
      return;
    }
    if (!manualContent.trim() && !manualImageUrl.trim()) {
      setError("请输入消息内容或图片链接。");
      return;
    }
    const result = await runAction(
      "manual-publish",
      {
        channelIds: manualChannelIds,
        content: manualContent,
        imageUrl: manualImageUrl,
      },
      "手动消息发送完成。",
    );
    const summary = result?.manualPublish;
    if (!summary) return;
    setManualResults(summary.results || []);
    setNotice(`手动发布完成：成功 ${summary.delivered} 个，失败 ${summary.failed} 个。`);
  }

  const gatewayOnline = status.gateway?.online === true;

  return (
    <ConsoleShell>
      <PageHeader
        title="Discord 社区"
        desc="连接官方 Bot，按 1–7 模板初始化 Demo Server 与目标 Server，并将 Demo 频道的新消息同步到所有已初始化的同编号频道。"
        action={(
          <button
            type="button"
            className="rounded-lg border border-ops-line bg-white px-4 py-2 text-sm font-black hover:border-ops-accent"
            onClick={loadStatus}
            disabled={loading || busy}
          >
            {loading ? "刷新中…" : "刷新状态"}
          </button>
        )}
      />

      {(notice || error) && (
        <div
          className={`mb-5 rounded-lg border px-4 py-3 text-sm font-bold ${
            error
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {error || notice}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-black">Bot 配置</h2>
            <StatusPill tone={status.configured ? "green" : "amber"}>
              {status.configured ? "已配置" : "待配置"}
            </StatusPill>
          </div>
          <p className="mt-3 text-sm leading-6 text-ops-muted">
            {status.credentials.tokenConfigured
              ? "Token 已加密保存在服务器，后台不会回显。"
              : "请在下方安全配置 App ID、Public Key 和 Bot Token。"}
          </p>
        </Card>
        <Card className="p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-black">Discord REST</h2>
            <StatusPill tone={status.connected ? "green" : "amber"}>
              {status.connected ? "连接正常" : "等待连接"}
            </StatusPill>
          </div>
          <p className="mt-3 text-sm leading-6 text-ops-muted">
            {status.bot
              ? `${status.bot.username} · 已识别 ${status.guilds.length} 个 Server`
              : "配置完成后自动读取 Bot 与 Server。"}
          </p>
        </Card>
        <Card className="p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-black">同步 Gateway</h2>
            <StatusPill tone={gatewayOnline ? "green" : "amber"}>
              {gatewayOnline ? "在线" : "离线"}
            </StatusPill>
          </div>
          <p className="mt-3 text-sm leading-6 text-ops-muted">
            最近心跳：{formatTime(status.gateway?.lastHeartbeatAt)}
          </p>
        </Card>
      </div>

      <Card className="mt-5 p-6">
        <div>
          <h2 className="text-xl font-black">Discord Bot 安全配置</h2>
          <p className="mt-2 text-sm leading-6 text-ops-muted">
            凭证只在服务器端加密保存。Bot Token 永不回显；Token 留空保存时会保留现有 Token。
          </p>
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-3">
          <Field label="App ID">
            <input
              className={inputClass}
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              placeholder="Discord Application ID"
              autoComplete="off"
            />
          </Field>
          <Field label="Public Key">
            <input
              className={inputClass}
              value={publicKey}
              onChange={(event) => setPublicKey(event.target.value)}
              placeholder="Discord Public Key"
              autoComplete="off"
            />
          </Field>
          <Field label="Bot Token">
            <input
              type="password"
              className={inputClass}
              value={botToken}
              onChange={(event) => setBotToken(event.target.value)}
              placeholder={status.credentials.tokenConfigured ? "已配置；留空保持不变" : "输入新的 Bot Token"}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            className="rounded-lg bg-ops-accent px-4 py-2 text-sm font-black text-white disabled:opacity-50"
            onClick={saveCredentials}
            disabled={Boolean(busy) || !appId.trim() || !publicKey.trim()}
          >
            {busy === "credential-save" ? "保存中…" : "安全保存"}
          </button>
          <button
            type="button"
            className="rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-black text-red-700 disabled:opacity-50"
            onClick={clearCredentials}
            disabled={Boolean(busy) || !status.credentials.configured}
          >
            {busy === "credential-clear" ? "清除中…" : "清除凭证"}
          </button>
        </div>
      </Card>

      <Card className="mt-5 p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-black">1. 安装 Bot</h2>
            <p className="mt-2 text-sm leading-6 text-ops-muted">
              将 Bot 加入 Demo 与目标 Server，并授予查看、发送、附件、历史记录和管理频道权限。
            </p>
          </div>
          {status.installUrl ? (
            <a
              href={status.installUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg bg-ops-accent px-4 py-2 text-center text-sm font-black text-white"
            >
              安装 Bot
            </a>
          ) : (
            <span className="rounded-lg bg-ops-soft px-4 py-2 text-sm font-black text-ops-muted">
              等待 App ID
            </span>
          )}
        </div>
        <div className="mt-4 rounded-lg bg-[#fff8e8] p-4 text-sm leading-6 text-[#8a641d]">
          同步需要在 Discord Developer Portal 开启 Bot 的 Message Content Intent。Discord Server
          中消息会显示 Bot 名称和头像，不能像 Telegram 匿名管理员一样显示为群官方身份。
        </div>
      </Card>

      <Card className="mt-5 p-6">
        <div>
          <h2 className="text-xl font-black">2. 初始化频道</h2>
          <p className="mt-2 text-sm leading-6 text-ops-muted">
            可按需选择频道。重复执行会复用同名分类和频道，不会重复创建。
          </p>
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(240px,0.7fr)_minmax(420px,1.3fr)]">
          <div className="grid content-start gap-4">
            <Field label="Discord Server">
              <select
                className={inputClass}
                value={guildId}
                onChange={(event) => setGuildId(event.target.value)}
              >
                <option value="">请选择 Server</option>
                {status.guilds.map((guild) => (
                  <option key={guild.id} value={guild.id}>{guild.name}</option>
                ))}
              </select>
            </Field>
            <label className="flex items-start gap-3 rounded-lg border border-ops-line p-4 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-ops-accent"
                checked={markAsDemo}
                onChange={(event) => setMarkAsDemo(event.target.checked)}
              />
              <span>
                <strong className="block">设为 Demo Server</strong>
                <span className="mt-1 block leading-5 text-ops-muted">
                  后续从该 Server 同步到已初始化的目标 Server。
                </span>
              </span>
            </label>
            {selectedGuild && (
              <div className="rounded-lg bg-ops-soft p-4 text-sm text-ops-muted">
                当前选择：<strong className="text-ops-ink">{selectedGuild.name}</strong>
              </div>
            )}
          </div>

          <div>
            <div className="grid gap-2 sm:grid-cols-2">
              {CHANNEL_TEMPLATES.map((template) => (
                <label
                  key={template.id}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-ops-line p-3 hover:border-ops-accent"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-ops-accent"
                    checked={selectedTemplateIds.includes(template.id)}
                    onChange={() => toggleTemplate(template.id)}
                  />
                  <span>
                    <strong className="block text-sm">{template.label}</strong>
                    <span className="mt-1 block text-xs text-ops-muted">#{template.name}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                className="rounded-lg border border-ops-line bg-white px-4 py-2 text-sm font-black hover:border-ops-accent"
                disabled={Boolean(busy)}
                onClick={() => initialize(true)}
              >
                {busy === "initialize" ? "处理中…" : "预览初始化"}
              </button>
              <button
                type="button"
                className="rounded-lg bg-ops-accent px-4 py-2 text-sm font-black text-white disabled:opacity-60"
                disabled={Boolean(busy)}
                onClick={() => initialize(false)}
              >
                初始化频道
              </button>
            </div>
          </div>
        </div>
      </Card>

      <Card className="mt-5 p-6">
        <h2 className="text-xl font-black">3. Demo → 目标同步规则</h2>
        <p className="mt-2 text-sm leading-6 text-ops-muted">
          以固定频道编号为主键，将 Demo Server 的新文字和附件同步到每个目标 Server 的同编号频道。
        </p>

        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <Field label="Demo Server">
            <select
              className={inputClass}
              value={demoGuildId}
              onChange={(event) => setDemoGuildId(event.target.value)}
            >
              <option value="">请选择已初始化的 Server</option>
              {initializedGuilds.map((guild) => (
                <option key={guild.guildId} value={guild.guildId}>{guild.guildName}</option>
              ))}
            </select>
          </Field>
          <div className="flex flex-wrap gap-3">
            <label className="flex min-h-10 items-center gap-2 rounded-lg border border-ops-line px-3 text-sm font-bold">
              <input
                type="checkbox"
                className="h-4 w-4 accent-ops-accent"
                checked={syncEnabled}
                onChange={(event) => setSyncEnabled(event.target.checked)}
              />
              开启自动同步
            </label>
            <button
              type="button"
              className="rounded-lg bg-ops-accent px-4 py-2 text-sm font-black text-white"
              disabled={Boolean(busy)}
              onClick={saveSettings}
            >
              保存同步设置
            </button>
          </div>
        </div>

        <div className="mt-5 overflow-hidden rounded-lg border border-ops-line">
          <div className="grid grid-cols-[70px_1fr_1fr] gap-3 bg-ops-soft px-4 py-3 text-xs font-black uppercase text-ops-muted">
            <span>编号</span>
            <span>Demo 来源</span>
            <span>目标</span>
          </div>
          {routes.length ? routes.map((route) => {
            const sourceGuild = status.config.guilds?.[route.sourceGuildId];
            const targetGuild = status.config.guilds?.[route.targetGuildId];
            const sourceChannel = sourceGuild?.channels?.find(
              (channel) => channel.channelId === route.sourceChannelId,
            );
            const targetChannel = targetGuild?.channels?.find(
              (channel) => channel.channelId === route.targetChannelId,
            );
            return (
              <div
                key={route.id}
                className="grid grid-cols-[70px_1fr_1fr] gap-3 border-t border-ops-line px-4 py-3 text-sm"
              >
                <strong>{route.templateId}</strong>
                <span>{sourceGuild?.guildName} / #{sourceChannel?.name}</span>
                <span>{targetGuild?.guildName} / #{targetChannel?.name}</span>
              </div>
            );
          }) : (
            <div className="border-t border-ops-line px-4 py-6 text-sm text-ops-muted">
              初始化一个 Demo Server 和至少一个目标 Server 后，将自动生成同编号同步规则。
            </div>
          )}
        </div>
      </Card>

      <Card className="mt-5 p-6">
        <h2 className="text-xl font-black">4. 发送测试消息</h2>
        <p className="mt-2 text-sm leading-6 text-ops-muted">
          先向指定频道发送一条测试消息，用于验证 Bot 发送权限；如该频道属于 Demo 且同步已开启，
          Gateway 会继续验证 Demo → 目标闭环。
        </p>
        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1.5fr_auto] lg:items-end">
          <Field label="测试频道">
            <select
              className={inputClass}
              value={testChannelId}
              onChange={(event) => setTestChannelId(event.target.value)}
            >
              <option value="">请选择频道</option>
              {initializedGuilds.flatMap((guild) => (guild.channels || []).map((channel) => (
                <option key={`${guild.guildId}:${channel.channelId}`} value={channel.channelId}>
                  {guild.guildName} / #{channel.name}
                </option>
              )))}
            </select>
          </Field>
          <Field label="测试内容">
            <input
              className={inputClass}
              value={testContent}
              maxLength={500}
              onChange={(event) => setTestContent(event.target.value)}
            />
          </Field>
          <button
            type="button"
            className="min-h-10 rounded-lg bg-ops-accent px-4 py-2 text-sm font-black text-white"
            disabled={Boolean(busy)}
            onClick={sendTestMessage}
          >
            发送测试消息
          </button>
        </div>
      </Card>

      <Card className="mt-5 p-6">
        <h2 className="text-xl font-black">5. 手动多目标发布</h2>
        <p className="mt-2 text-sm leading-6 text-ops-muted">
          将同一条文字或图片消息直接发送到多个 Discord 频道。Server 默认折叠，单个目标失败不会影响其他目标。
        </p>

        <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1.3fr]">
          <div className="space-y-3">
            {initializedGuilds.length ? initializedGuilds.map((guild) => {
              const selectedCount = (guild.channels || [])
                .filter((channel) => manualChannelIds.includes(channel.channelId)).length;
              return (
                <details key={guild.guildId} className="overflow-hidden rounded-lg border border-ops-line bg-white">
                  <summary className="cursor-pointer px-4 py-3 font-black">
                    {guild.guildName}
                    <span className="ml-2 text-xs font-bold text-ops-muted">
                      已选 {selectedCount}/{guild.channels?.length || 0}
                    </span>
                  </summary>
                  <div className="border-t border-ops-line px-4 py-2">
                    {(guild.channels || []).map((channel) => (
                      <label
                        key={`${guild.guildId}:${channel.channelId}`}
                        className="flex cursor-pointer items-center gap-3 border-b border-ops-line py-3 last:border-0"
                      >
                        <input
                          type="checkbox"
                          checked={manualChannelIds.includes(channel.channelId)}
                          onChange={() => toggleManualChannel(channel.channelId)}
                        />
                        <span className="text-sm font-bold">#{channel.name}</span>
                      </label>
                    ))}
                  </div>
                </details>
              );
            }) : (
              <div className="rounded-lg border border-dashed border-ops-line p-4 text-sm text-ops-muted">
                请先初始化至少一个 Discord Server。
              </div>
            )}
          </div>

          <div className="space-y-4">
            <Field label="消息内容">
              <textarea
                className={`${inputClass} min-h-36 resize-y`}
                value={manualContent}
                maxLength={2000}
                placeholder="输入需要发布到所选频道的内容"
                onChange={(event) => setManualContent(event.target.value)}
              />
            </Field>
            <Field label="图片链接（可选）">
              <input
                className={inputClass}
                value={manualImageUrl}
                placeholder="https://example.com/image.png"
                onChange={(event) => setManualImageUrl(event.target.value)}
              />
            </Field>
            <button
              type="button"
              className="min-h-10 rounded-lg bg-ops-accent px-5 py-2 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={Boolean(busy) || !manualChannelIds.length || (!manualContent.trim() && !manualImageUrl.trim())}
              onClick={sendManualMessage}
            >
              {busy === "manual-publish" ? "发送中…" : `发送到 ${manualChannelIds.length} 个频道`}
            </button>

            {manualResults.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-ops-line">
                {manualResults.map((result) => (
                  <div
                    key={result.channelId}
                    className="flex items-start justify-between gap-4 border-b border-ops-line px-4 py-3 text-sm last:border-0"
                  >
                    <span className="font-bold">{getManualTarget(result.channelId)}</span>
                    <span className={result.ok ? "font-bold text-emerald-700" : "max-w-64 text-right font-bold text-red-700"}>
                      {result.ok ? "发送成功" : result.error || "发送失败"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Card>
    </ConsoleShell>
  );
}
