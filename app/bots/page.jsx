"use client";

import { useEffect, useMemo, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import LiveStatusStamp from "../components/LiveStatusStamp";
import { Card, PageHeader, StatusPill } from "../components/ui";
import { useLiveAutoRefresh } from "../hooks/useLiveAutoRefresh";
import { getBotOperationalStatus } from "../../lib/live-status.mjs";

const fallbackBots = [
  { name: "AdminBot", role: "群管理 / 建群 / 公告", username: "Bonnie_geniustrader_bot", status: "读取中", groups: [] },
  { name: "SpeakerBot", role: "新闻 / 分析 / 信号发布", username: "Satoshi_geniustrader_bot", status: "读取中", groups: [] },
  { name: "ForwardBot", role: "广播 / 代理社媒转发", username: "Biupa_geniustrader_bot", status: "读取中", groups: [] }
];

export default function BotsPage() {
  const [bots, setBots] = useState(fallbackBots);
  const [status, setStatus] = useState("正在读取 Telegram 实时状态");
  const [running, setRunning] = useState(true);
  const [generatedAt, setGeneratedAt] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const coveredGroupCount = useMemo(() => new Set(bots.flatMap((bot) => (bot.groups || []).map((group) => String(group.id)))).size, [bots]);
  const availableCount = bots.filter((bot) => bot.apiAvailable ?? (bot.status === "在线")).length;

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
        title="机器人配置"
        desc="按 Telegram 当前成员身份核验三个 Bot 所在群；已退出群和升级前的旧群会自动隐藏。"
        action={<button className="min-h-10 rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent" disabled={running} onClick={() => refresh()}>{running ? "刷新中..." : "刷新机器人群"}</button>}
      />
      <div className="mb-4"><LiveStatusStamp generatedAt={generatedAt} error={refreshError} refreshing={running} /></div>
      <section className="mb-5 grid gap-0 overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops md:grid-cols-4">
        <MetricBox label="机器人" value={String(bots.length)} sub="已配置角色" />
        <MetricBox label="API 可用" value={String(availableCount)} sub="仅表示 Bot API 与身份核验通过" />
        <MetricBox label="有效群" value={String(coveredGroupCount)} sub="已去重并核验成员身份" />
        <MetricBox label="状态" value={status} sub={generatedAt ? new Date(generatedAt).toLocaleString("zh-CN") : "不显示 Token"} />
      </section>
      <Card className="overflow-hidden">
        <div className="border-b border-ops-line p-5">
          <h2 className="text-xl font-black">机器人所在群</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted">
              <tr><th className="px-5 py-3">机器人</th><th className="px-5 py-3">职责</th><th className="px-5 py-3">当前有效群</th><th className="px-5 py-3">状态</th></tr>
            </thead>
            <tbody>
              {bots.map((bot) => {
                const botStatus = getBotOperationalStatus({ bot, generatedAt });
                return <tr className="border-t border-ops-line align-top" key={bot.name}>
                  <td className="px-5 py-4"><b>{bot.name}</b>{bot.username ? <div className="mt-1 text-xs text-ops-muted">@{bot.username}</div> : null}</td>
                  <td className="px-5 py-4">{bot.role}</td>
                  <td className="px-5 py-4">
                    {(bot.groups || []).length ? <div className="grid gap-2">{bot.groups.map((group) => (
                      <div className="rounded-lg border border-ops-line bg-[#fbfcfb] px-3 py-2" key={group.chatId || group.id}>
                        <div className="flex flex-wrap items-center gap-2"><b>{group.title}</b><span className={`rounded-full px-2 py-0.5 text-[11px] font-black ${group.isForum ? "bg-[#e6f7ef] text-ops-accent" : "bg-[#fff5dd] text-[#91620d]"}`}>{group.isForum ? "Forum / Topic 可用" : "未开启 Topics"}</span>{group.bound ? <span className="rounded-full bg-[#edf2ff] px-2 py-0.5 text-[11px] font-black text-[#536aa1]">已保存</span> : null}</div>
                        <div className="mt-1 font-mono text-[11px] text-ops-muted">{group.chatId || group.id} · {memberLabel(group.membership)}{group.isForum ? ` · ${group.canManageTopics ? "可管理 Topic" : "无 Topic 管理权限"}` : ""}</div>
                      </div>
                    ))}</div> : <span className="text-ops-muted">暂无有效群，请确认机器人已入群并产生过更新</span>}
                  </td>
                  <td className="px-5 py-4"><StatusPill tone={botStatus.tone}>{botStatus.label}</StatusPill><div className="mt-2 text-xs text-ops-muted">{botStatus.detail}</div></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="mt-4 rounded-lg border border-ops-line bg-white px-5 py-4 text-sm leading-6 text-ops-muted">说明：“API 可用”不等于 Bot 已在某个群拥有管理员权限。群卡片会分别显示成员身份和 Topic 权限；Telegram 不提供“列出全部群”的接口，因此后台基于群事件与已保存群逐一实时复核。</div>
    </ConsoleShell>
  );
}

function memberLabel(status) {
  if (status === "administrator") return "管理员";
  if (status === "creator") return "群主";
  if (status === "member") return "成员";
  if (status === "restricted") return "受限成员";
  return "待确认";
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
