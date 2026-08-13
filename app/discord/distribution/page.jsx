"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import ConsoleShell from "../../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../../components/ui";

const TASKS = [
  { name: "Daily Events", detail: "每日市场事件：独立海报 + 英文正文" },
  { name: "Daily Analysis", detail: "每日行情分析：图文合并发布" },
  { name: "Whale Signals", detail: "巨鲸与大户挂单：英文图文" },
];

export default function DiscordDistributionPage() {
  const [status, setStatus] = useState({ config: { guilds: {}, routes: [], demoGuildId: "", syncEnabled: false } });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [demoGuildId, setDemoGuildId] = useState("");
  const [syncEnabled, setSyncEnabled] = useState(false);

  const applyStatus = useCallback((payload) => {
    const config = { guilds: {}, routes: [], demoGuildId: "", syncEnabled: false, ...(payload?.config || {}) };
    setStatus({ ...payload, config });
    setDemoGuildId(config.demoGuildId || "");
    setSyncEnabled(config.syncEnabled === true);
  }, []);

  const load = useCallback(async () => {
    try {
      setError("");
      const response = await fetch("/api/discord", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Discord 内容分发配置读取失败。");
      applyStatus(payload);
    } catch (requestError) {
      setError(requestError.message || "Discord 内容分发配置读取失败。");
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => { load(); }, [load]);

  const guilds = useMemo(() => Object.values(status.config.guilds || {}).sort(
    (left, right) => String(left.guildName).localeCompare(String(right.guildName)),
  ), [status.config.guilds]);

  async function saveSettings() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/discord", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "settings", demoGuildId, syncEnabled }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "同步设置保存失败。");
      applyStatus(payload);
      setNotice("Demo Server 与同步开关已保存。");
    } catch (requestError) {
      setError(requestError.message || "同步设置保存失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConsoleShell>
      <PageHeader
        title="Discord 内容分发中心"
        desc="统一管理 Discord 自动发布模板与 Demo → 目标同步规则；Telegram 规则不会在这里混入。"
        action={<Link href="/distribution?view=automation&platform=discord" className="rounded-lg bg-ops-ink px-4 py-2 text-sm font-black text-white">管理自动发布任务</Link>}
      />
      {loading && <div className="mb-4 text-sm text-ops-muted">正在读取分发配置…</div>}
      {notice && <div className="mb-4 rounded-lg bg-[#e6f7ef] px-4 py-3 text-sm font-bold text-ops-accent">{notice}</div>}
      {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

      <div className="grid gap-4 lg:grid-cols-3">
        {TASKS.map((task) => <Card key={task.name} className="p-5"><div className="flex items-center justify-between gap-3"><h2 className="font-black">{task.name}</h2><StatusPill tone="green">模板共用</StatusPill></div><p className="mt-3 text-sm leading-6 text-ops-muted">{task.detail}</p><Link href="/distribution?view=automation&platform=discord" className="mt-4 inline-flex text-sm font-black text-ops-accent">查看模板与目标 →</Link></Card>)}
      </div>

      <Card className="mt-6 p-6">
        <h2 className="text-xl font-black">Demo → 目标同步规则</h2>
        <p className="mt-2 text-sm text-ops-muted">来源和目标均按稳定的 Server ID + Channel ID 保存，不依赖频道名称猜测。</p>
        <div className="mt-5 grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
          <Field label="Discord Demo Server"><select className={inputClass} value={demoGuildId} onChange={(event) => setDemoGuildId(event.target.value)}><option value="">请选择已初始化 Server</option>{guilds.map((guild) => <option key={guild.guildId} value={guild.guildId}>{guild.guildName}</option>)}</select></Field>
          <label className="flex min-h-10 items-center gap-2 rounded-lg border border-ops-line px-4 text-sm font-bold"><input type="checkbox" checked={syncEnabled} onChange={(event) => setSyncEnabled(event.target.checked)} />启用 Discord 同步</label>
        </div>
        <button type="button" disabled={busy} onClick={saveSettings} className="mt-4 rounded-lg bg-ops-accent px-4 py-2 text-sm font-black text-white disabled:opacity-50">保存基础设置</button>

        <div className="mt-6 grid gap-3">
          {(status.config.routes || []).length === 0 ? <div className="rounded-lg border border-dashed border-ops-line p-5 text-sm text-ops-muted">暂无同步规则。请先完成 Demo Server 初始化，再创建 Channel 映射。</div> : status.config.routes.map((route, index) => <div key={route.id || `${route.sourceChannelId}-${route.targetChannelId}-${index}`} className="flex flex-col gap-2 rounded-lg border border-ops-line p-4 md:flex-row md:items-center md:justify-between"><div className="text-sm font-bold">{route.sourceGuildName || route.sourceGuildId} / #{route.sourceChannelName || route.sourceChannelId} → {route.targetGuildName || route.targetGuildId} / #{route.targetChannelName || route.targetChannelId}</div><StatusPill tone={route.enabled === false ? "gray" : "green"}>{route.enabled === false ? "已暂停" : "运行中"}</StatusPill></div>)}
        </div>
      </Card>
    </ConsoleShell>
  );
}
