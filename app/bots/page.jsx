"use client";

import { useEffect, useMemo, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import LiveStatusStamp from "../components/LiveStatusStamp";
import { Card, PageHeader, StatusPill } from "../components/ui";
import { useLiveAutoRefresh } from "../hooks/useLiveAutoRefresh";
import { buildBotAccessScopes, getBotOperationalStatus } from "../../lib/live-status.mjs";

const fallbackBots = [
  { name: "AdminBot", role: "目标群发现 / Topic 初始化 / 权限复核", username: "Bonnie_geniustrader_bot", status: "读取中", groups: [] },
  { name: "SpeakerBot", role: "Trader 私聊接收 / 订单核验", username: "Satoshi_geniustrader_bot", status: "读取中", groups: [] },
  { name: "ForwardBot", role: "Telegram 来源监听 / 广播入站", username: "Biupa_geniustrader_bot", status: "读取中", groups: [] }
];

export default function BotsPage() {
  const [bots, setBots] = useState(fallbackBots);
  const [status, setStatus] = useState("正在读取 Telegram 实时状态");
  const [running, setRunning] = useState(true);
  const [generatedAt, setGeneratedAt] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const accessScopes = useMemo(() => buildBotAccessScopes(bots), [bots]);
  const coveredGroupCount = accessScopes.length;
  const availableCount = bots.filter((bot) => bot.apiAvailable ?? (bot.status === "在线")).length;
  const hasLiveResult = Boolean(generatedAt);

  useEffect(() => { refresh(); }, []);
  useLiveAutoRefresh(() => refresh({ silent: true }), { enabled: !running });

  async function refresh({ silent = false } = {}) {
    if (!silent) {
      setRunning(true);
      setStatus("读取中");
    }
    try {
      const response = await fetch(`/api/bot-groups?t=${Date.now()}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "读取失败");
      setBots(data.bots || fallbackBots);
      setGeneratedAt(data.generatedAt || "");
      setRefreshError("");
      const hidden = Math.max(...(data.bots || []).map((bot) => Number(bot.migratedGroupsHidden || 0)), 0);
      setStatus(hidden ? `已刷新 · 已隐藏 ${hidden} 条迁移历史` : "已刷新");
    } catch (error) {
      setRefreshError(error.message);
      if (!silent) setStatus("刷新失败");
    } finally {
      if (!silent) setRunning(false);
    }
  }

  return (
    <ConsoleShell>
      <PageHeader
        title="后台能力"
        desc="@Serenity_Crypto 是唯一主发布账号，对外显示目标群身份；三个 Bot 继续作为后台能力组件运行，不再作为目标群的共同准入条件。"
        action={<button className="min-h-10 rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent" disabled={running} onClick={() => refresh()}>{running ? "刷新中..." : "刷新能力状态"}</button>}
      />
      <div className="mb-4"><LiveStatusStamp generatedAt={generatedAt} error={refreshError} refreshing={running} /></div>
      <section className="mb-5 grid gap-0 overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops md:grid-cols-4">
        <MetricBox label="能力组件" value={hasLiveResult ? String(bots.length) : "—"} sub={hasLiveResult ? "保留全部原有功能" : "正在读取…"} />
        <MetricBox label="API 可用" value={hasLiveResult ? String(availableCount) : "—"} sub={hasLiveResult ? "仅表示 Bot API 与身份核验通过" : "正在核验…"} />
        <MetricBox label="有效群" value={hasLiveResult ? String(coveredGroupCount) : "—"} sub={hasLiveResult ? "已去重并核验成员身份" : "正在核验…"} />
        <MetricBox label="状态" value={hasLiveResult ? status : "正在读取"} sub={generatedAt ? new Date(generatedAt).toLocaleString("zh-CN") : "等待实时结果"} />
      </section>
      <Card className="overflow-hidden">
        <div className="border-b border-ops-line p-5">
          <h2 className="text-xl font-black">后台能力运行状态</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted">
              <tr><th className="px-5 py-3">组件</th><th className="px-5 py-3">职责</th><th className="px-5 py-3">状态</th></tr>
            </thead>
            <tbody>
              {bots.map((bot) => {
                const botStatus = getBotOperationalStatus({ bot, generatedAt });
                return <tr className="border-t border-ops-line align-top" key={bot.name}>
                  <td className="px-5 py-4"><b>{bot.name}</b>{bot.username ? <div className="mt-1 text-xs text-ops-muted">@{bot.username}</div> : null}</td>
                  <td className="px-5 py-4">{bot.role}</td>
                  <td className="px-5 py-4"><StatusPill tone={botStatus.tone}>{botStatus.label}</StatusPill><div className="mt-2 text-xs text-ops-muted">{botStatus.detail}</div></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card className="mt-5 overflow-hidden">
        <div className="border-b border-ops-line p-5">
          <h2 className="text-xl font-black">当前可访问范围</h2>
          <p className="mt-1 text-sm leading-6 text-ops-muted">每个群仅显示一次；标签表示已识别该群的后台能力组件。</p>
        </div>
        {accessScopes.length ? <div className="grid gap-3 p-5 md:grid-cols-2">
          {accessScopes.map((scope) => (
            <div className="rounded-lg border border-ops-line bg-[#fbfcfb] px-4 py-3" key={scope.chatId}>
              <div className="flex flex-wrap items-center gap-2">
                <b>{scope.title}</b>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-black ${scope.isForum ? "bg-[#e6f7ef] text-ops-accent" : "bg-[#fff5dd] text-[#91620d]"}`}>{scope.isForum ? "Forum / Topic 可用" : "未开启 Topics"}</span>
                {scope.bound ? <span className="rounded-full bg-[#edf2ff] px-2 py-0.5 text-[11px] font-black text-[#536aa1]">已保存</span> : null}
              </div>
              <div className="mt-2 font-mono text-[11px] text-ops-muted">{scope.chatId}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {scope.components.map((component) => <span className="rounded-full border border-ops-line bg-white px-2 py-1 text-[11px] font-black text-[#52605a]" key={component}>{component}</span>)}
              </div>
            </div>
          ))}
        </div> : <div className="p-8 text-center text-sm font-bold text-ops-muted">暂无有效群，请确认能力组件已入群并产生过更新。</div>}
      </Card>
      <div className="mt-4 rounded-lg border border-ops-line bg-white px-5 py-4 text-sm leading-6 text-ops-muted">AdminBot 需在目标群拥有管理员与 Topic 权限；SpeakerBot 只接收 Trader 私聊，ForwardBot 只监听已配置来源，两者无需加入每个目标群。所有出站内容统一进入 @Serenity_Crypto 发布队列。</div>
    </ConsoleShell>
  );
}

function MetricBox({ label, value, sub }) {
  return (
    <div className="border-b border-ops-line p-5 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
      <div className="text-sm font-bold text-ops-muted">{label}</div>
      <div className="mt-1 text-2xl font-black">{value}</div>
      <div className="mt-1 text-xs text-ops-muted">{sub}</div>
    </div>
  );
}
