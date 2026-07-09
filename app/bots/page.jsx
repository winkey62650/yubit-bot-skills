"use client";

import { useMemo, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, PageHeader, StatusPill } from "../components/ui";

const fallbackBots = [
  { name: "YUBITadmin", role: "群管理 / 建群 / 公告", status: "待刷新", groups: [] },
  { name: "Trader1", role: "新闻 / 信号推送", status: "待刷新", groups: [] },
  { name: "MOD1", role: "人工管理辅助", status: "待刷新", groups: [] },
  { name: "Jack", role: "市场讨论", status: "待刷新", groups: [] },
  { name: "Tony", role: "风险讨论", status: "待刷新", groups: [] }
];

export default function BotsPage() {
  const [bots, setBots] = useState(fallbackBots);
  const [status, setStatus] = useState("待刷新");
  const [running, setRunning] = useState(false);
  const coveredGroupCount = useMemo(() => new Set(bots.flatMap((bot) => (bot.groups || []).map((group) => String(group.id)))).size, [bots]);
  const onlineCount = bots.filter((bot) => bot.status === "在线").length;

  async function refresh() {
    setRunning(true);
    setStatus("读取中");
    try {
      const response = await fetch("/api/bot-groups");
      const data = await response.json();
      setBots(data.bots || fallbackBots);
      setStatus("已刷新");
    } catch (error) {
      setStatus(`失败：${error.message}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <ConsoleShell>
      <PageHeader
        title="机器人配置"
        desc="查看每个机器人接入了哪些群，以及它在运营系统里的职责。"
        action={<button className="min-h-10 rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent" disabled={running} onClick={refresh}>{running ? "刷新中..." : "刷新机器人群"}</button>}
      />
      <section className="mb-5 grid gap-0 overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops md:grid-cols-4">
        <MetricBox label="机器人" value={String(bots.length)} sub="已配置角色" />
        <MetricBox label="在线" value={String(onlineCount)} sub="Bot API 可连通" />
        <MetricBox label="覆盖群" value={String(coveredGroupCount)} sub="按 getUpdates 可见" />
        <MetricBox label="状态" value={status} sub="不显示 Token" />
      </section>
      <Card className="overflow-hidden">
        <div className="border-b border-ops-line p-5">
          <h2 className="text-xl font-black">机器人所在群</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted">
              <tr><th className="px-5 py-3">机器人</th><th className="px-5 py-3">职责</th><th className="px-5 py-3">所在群</th><th className="px-5 py-3">状态</th></tr>
            </thead>
            <tbody>
              {bots.map((bot) => (
                <tr className="border-t border-ops-line align-top" key={bot.name}>
                  <td className="px-5 py-4"><b>{bot.name}</b>{bot.username ? <div className="mt-1 text-xs text-ops-muted">@{bot.username}</div> : null}</td>
                  <td className="px-5 py-4">{bot.role}</td>
                  <td className="px-5 py-4">
                    {(bot.groups || []).length ? bot.groups.map((group) => <span className="mb-2 mr-2 inline-block rounded-lg bg-[#edf7f2] px-2 py-1 text-xs font-black text-ops-accent" key={group.id}>{group.title}</span>) : <span className="text-ops-muted">暂无可见群</span>}
                  </td>
                  <td className="px-5 py-4"><StatusPill tone={bot.status === "在线" ? "green" : "amber"}>{bot.status}</StatusPill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
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
