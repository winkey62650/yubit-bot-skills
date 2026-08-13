"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import ConsoleShell from "../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../components/ui";

const CHANNEL_TEMPLATES = [
  { id: 1, label: "1. READ FIRST - DISCLAIMER" },
  { id: 2, label: "2. CryptoGuy Trading Zone" },
  { id: 3, label: "3. Market Events" },
  { id: 4, label: "4. Market Analysis - Crypto/Stocks/TradFi" },
  { id: 5, label: "5. Community Signal" },
  { id: 6, label: "6. Smart Money Tracker" },
  { id: 7, label: "7. YUBIT Updates" },
];

const initialStatus = {
  configured: false,
  connected: false,
  credentials: { appId: "", publicKey: "", publicKeyConfigured: false, tokenConfigured: false },
  installUrl: "",
  bot: null,
  guilds: [],
  config: { guilds: {}, routes: [], demoGuildId: "", syncEnabled: false },
  gateway: null,
};

function formatTime(value) {
  if (!value) return "尚无心跳";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "尚无心跳" : date.toLocaleString("zh-CN", { hour12: false });
}

export default function DiscordCommunityPage() {
  const [status, setStatus] = useState(initialStatus);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [guildId, setGuildId] = useState("");
  const [selectedTemplateIds, setSelectedTemplateIds] = useState(CHANNEL_TEMPLATES.map(({ id }) => id));
  const [markAsDemo, setMarkAsDemo] = useState(false);
  const [appId, setAppId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [botToken, setBotToken] = useState("");

  const applyStatus = useCallback((payload) => {
    const next = {
      ...initialStatus,
      ...payload,
      config: { ...initialStatus.config, ...(payload?.config || {}) },
      credentials: { ...initialStatus.credentials, ...(payload?.credentials || {}) },
    };
    setStatus(next);
    setGuildId((current) => current || next.guilds?.[0]?.id || "");
    setAppId(next.credentials.appId || "");
    setPublicKey(next.credentials.publicKey || "");
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setError("");
      const response = await fetch("/api/discord", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Discord 状态读取失败。");
      applyStatus(payload);
    } catch (requestError) {
      setError(requestError.message || "Discord 状态读取失败。");
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const selectedGuild = useMemo(
    () => status.guilds.find((guild) => String(guild.id) === String(guildId)),
    [guildId, status.guilds],
  );

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
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Discord 操作失败。");
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

  async function saveCredentials() {
    const result = await runAction("credential-save", { appId, publicKey, botToken }, "Discord Bot 凭证已安全保存。");
    if (result) setBotToken("");
  }

  async function clearCredentials() {
    if (!window.confirm("确认清除服务器保存的 Discord Bot 凭证？")) return;
    const result = await runAction("credential-clear", {}, "Discord Bot 凭证已清除。");
    if (result) setBotToken("");
  }

  function toggleTemplate(templateId) {
    setSelectedTemplateIds((current) => current.includes(templateId)
      ? current.filter((id) => id !== templateId)
      : [...current, templateId].sort((left, right) => left - right));
  }

  async function initialize(dryRun) {
    if (!guildId) return setError("请先选择一个 Discord Server。");
    if (!selectedTemplateIds.length) return setError("请至少选择一个频道模板。");
    const result = await runAction(
      "initialize",
      { guildId, templateIds: selectedTemplateIds, dryRun, markAsDemo },
      dryRun ? "初始化预览已生成，尚未修改 Server。" : "频道初始化完成。",
    );
    if (dryRun && result?.initialized?.plan) {
      const channels = result.initialized.plan.channels || [];
      setNotice(`初始化预览：将新建 ${channels.filter(({ action }) => action === "create").length} 个频道，复用 ${channels.filter(({ action }) => action !== "create").length} 个频道。`);
    }
  }

  return (
    <ConsoleShell>
      <PageHeader
        title="Discord 社区"
        desc="这里只管理 Bot 连接、安装和 Server 频道初始化；内容分发、手动发布与健康检查已拆分为独立页面。"
        action={<button type="button" onClick={loadStatus} className="rounded-lg border border-ops-line bg-white px-4 py-2 text-sm font-black">刷新状态</button>}
      />

      {loading && <div className="mb-4 text-sm text-ops-muted">正在读取 Discord 状态…</div>}
      {notice && <div className="mb-4 rounded-lg bg-[#e6f7ef] px-4 py-3 text-sm font-bold text-ops-accent">{notice}</div>}
      {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card className="p-5"><div className="text-sm font-bold text-ops-muted">REST API</div><div className="mt-3"><StatusPill tone={status.connected ? "green" : "amber"}>{status.connected ? "已连接" : "未连接"}</StatusPill></div><div className="mt-3 text-xs text-ops-muted">{status.bot?.username ? `@${status.bot.username}` : "等待 Bot Token"}</div></Card>
        <Card className="p-5"><div className="text-sm font-bold text-ops-muted">Gateway</div><div className="mt-3"><StatusPill tone={status.gateway?.online ? "green" : "amber"}>{status.gateway?.online ? "在线" : "离线"}</StatusPill></div><div className="mt-3 text-xs text-ops-muted">最后心跳：{formatTime(status.gateway?.lastHeartbeatAt)}</div></Card>
        <Card className="p-5"><div className="text-sm font-bold text-ops-muted">已识别 Server</div><div className="mt-2 text-2xl font-black">{status.guilds.length}</div><div className="mt-2 text-xs text-ops-muted">已初始化 {Object.keys(status.config.guilds || {}).length} 个</div></Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="p-6">
          <h2 className="text-xl font-black">Bot 连接配置</h2>
          <p className="mt-2 text-sm text-ops-muted">Token 仅保存在服务端，不会回显到浏览器。</p>
          <div className="mt-5 grid gap-4">
            <Field label="Application ID"><input className={inputClass} value={appId} onChange={(event) => setAppId(event.target.value)} /></Field>
            <Field label="Public Key"><input className={inputClass} value={publicKey} onChange={(event) => setPublicKey(event.target.value)} /></Field>
            <Field label="Bot Token"><input type="password" className={inputClass} value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder={status.credentials.tokenConfigured ? "已配置；留空表示不变" : "输入新的 Bot Token"} /></Field>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" disabled={busy === "credential-save"} onClick={saveCredentials} className="rounded-lg bg-ops-ink px-4 py-2 text-sm font-black text-white disabled:opacity-50">保存并验证</button>
            <button type="button" onClick={clearCredentials} className="rounded-lg border border-ops-line px-4 py-2 text-sm font-black">清除凭证</button>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-xl font-black">安装 Bot</h2>
          <p className="mt-2 text-sm leading-6 text-ops-muted">先将 Bot 安装到已有 Server，并授予查看频道、发送消息、嵌入链接与上传附件权限。</p>
          {status.installUrl ? <a href={status.installUrl} target="_blank" rel="noreferrer" className="mt-5 inline-flex rounded-lg bg-[#5865f2] px-4 py-2 text-sm font-black text-white">打开 Discord 安装页</a> : <div className="mt-5 text-sm font-bold text-amber-700">保存 Application ID 后生成安装链接。</div>}
          <button type="button" onClick={loadStatus} className="mt-3 block rounded-lg border border-ops-line px-4 py-2 text-sm font-black">安装后重新识别</button>
        </Card>
      </div>

      <Card className="mt-6 p-6">
        <h2 className="text-xl font-black">初始化频道</h2>
        <p className="mt-2 text-sm text-ops-muted">选择 Server 与需要创建的频道；重复执行会复用已有频道。</p>
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]">
          <div className="grid gap-4">
            <Field label="Discord Server"><select className={inputClass} value={guildId} onChange={(event) => setGuildId(event.target.value)}><option value="">请选择 Server</option>{status.guilds.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select></Field>
            <label className="flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={markAsDemo} onChange={(event) => setMarkAsDemo(event.target.checked)} />设为 Discord Demo Server</label>
            {selectedGuild && <div className="rounded-lg bg-ops-soft p-3 text-sm">当前选择：<strong>{selectedGuild.name}</strong></div>}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {CHANNEL_TEMPLATES.map((template) => <label key={template.id} className="flex items-center gap-3 rounded-lg border border-ops-line p-3 text-sm font-bold"><input type="checkbox" checked={selectedTemplateIds.includes(template.id)} onChange={() => toggleTemplate(template.id)} />{template.label}</label>)}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <button type="button" disabled={busy === "initialize"} onClick={() => initialize(true)} className="rounded-lg border border-ops-line px-4 py-2 text-sm font-black">预览初始化</button>
          <button type="button" disabled={busy === "initialize"} onClick={() => initialize(false)} className="rounded-lg bg-ops-accent px-4 py-2 text-sm font-black text-white">一键初始化</button>
        </div>
      </Card>
    </ConsoleShell>
  );
}
