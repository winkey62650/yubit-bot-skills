"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../components/ui";

export default function GroupConfigPage() {
  const [groups, setGroups] = useState([]);
  const [status, setStatus] = useState("正在读取已保存群配置…");
  const [busy, setBusy] = useState(false);
  const [manualChatId, setManualChatId] = useState("");

  useEffect(() => { loadSavedGroups(); }, []);

  async function loadSavedGroups() {
    try {
      const response = await fetch("/api/group-config", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "群配置读取失败");
      setGroups(data.groups || []);
      setStatus(data.groups?.length ? `已读取 ${data.groups.length} 个群；规则绑定请在内容分发中心管理。` : "暂无已保存群，请刷新 Telegram 群列表。");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function discoverChats() {
    setBusy(true);
    setStatus("正在通过 Telegram 事件和权限接口复核…");
    try {
      const response = await fetch("/api/chats", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Telegram 群发现失败");
      const saveResponse = await fetch("/api/group-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groups: data.chats || [], mode: "telegram-refresh" })
      });
      const saved = await saveResponse.json();
      if (!saveResponse.ok || !saved.ok) throw new Error(saved.error || "群配置保存失败");
      setGroups(saved.groups || []);
      const forumCount = saved.groups?.filter((group) => group.canUseTopics).length || 0;
      setStatus(saved.preservedExisting
        ? saved.warning
        : `已刷新 ${saved.groups?.length || 0} 个群，其中 ${forumCount} 个已开启 Topics。`);
    } catch (error) {
      setStatus(`刷新失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function probeAndSaveChat() {
    if (busy) return;
    const normalizedChatId = manualChatId.trim();
    if (!/^-100\d+$/.test(normalizedChatId)) {
      setStatus("请输入以 -100 开头的 Telegram 超级群 ID。");
      return;
    }
    setBusy(true);
    setStatus("正在由服务器上的三个 Bot 直接检查群与管理员权限…");
    try {
      const response = await fetch("/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: normalizedChatId })
      });
      const data = await response.json();
      if (!response.ok || !data.ok || !data.group) throw new Error(data.error || "群检测失败");
      const mergedGroups = [data.group, ...groups.filter((group) => String(group.chatId) !== normalizedChatId)];
      const saveResponse = await fetch("/api/group-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groups: mergedGroups })
      });
      const saved = await saveResponse.json();
      if (!saveResponse.ok || !saved.ok) throw new Error(saved.error || "群配置保存失败");
      setGroups(saved.groups || mergedGroups);
      setManualChatId("");
      setStatus(`${data.group.title} 已检测并保存：三个 Bot 管理员 ${data.group.adminBotCount}/3，${data.group.canUseTopics ? "Topics 已开启" : "Topics 未开启"}。`);
    } catch (error) {
      setStatus(`检测失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  const topicCount = groups.reduce((total, group) => total + (group.topics?.length || 0), 0);
  const confirmedTopics = groups.reduce((total, group) => total + (group.topics?.filter((topic) => topic.threadId).length || 0), 0);

  return (
    <ConsoleShell>
      <PageHeader
        title="群与 Topic 配置"
        desc="这里只维护群、Topic、三个 Bot 权限和健康状态；内容来源与目标绑定已统一迁移到内容分发中心。"
        action={<Link className="grid min-h-11 place-items-center rounded-lg bg-ops-accent px-5 text-sm font-black text-white" href="/distribution">进入内容分发中心</Link>}
      />

      <section className="mb-5 grid overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="已配置群" value={groups.length} detail="跨设备持久保存" />
        <Metric label="Forum 群" value={groups.filter((group) => group.canUseTopics).length} detail="已核验 Topics 开关" />
        <Metric label="Topic 总数" value={topicCount} detail={`${confirmedTopics} 个已确认 Thread ID`} />
        <Metric label="三 Bot 就绪" value={groups.filter((group) => group.allBotsAdmin).length} detail={`共 ${groups.length} 个群`} />
      </section>

      <Card className="overflow-hidden">
        <div className="border-b border-ops-line bg-[#f7faf8] p-5">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <Field label="新群 ID">
              <input className={`${inputClass} w-full`} value={manualChatId} onChange={(event) => setManualChatId(event.target.value)} placeholder="-100xxxxxxxxxx" />
            </Field>
            <button className="min-h-11 rounded-lg bg-ops-accent px-5 text-sm font-black text-white disabled:opacity-50" disabled={busy} onClick={probeAndSaveChat} type="button">{busy ? "正在检测…" : "按群 ID 检测并保存"}</button>
          </div>
          <p className="mt-2 text-xs font-bold text-ops-muted">无需在这台 Mac 登录三个 Bot。后台会使用服务器端 Bot API，直接检查群、Topics 和管理员权限；新群首次登记请填写群 ID。</p>
        </div>
        <div className="flex flex-col gap-4 border-b border-ops-line p-5 md:flex-row md:items-center md:justify-between">
          <div><h2 className="text-xl font-black">Telegram 群健康状态</h2><p className="mt-1 text-sm text-ops-muted">刷新用于复核已登记群；ForwardBot 启用 Webhook 后不再与 getUpdates 并行轮询。</p></div>
          <button className="min-h-11 rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent disabled:opacity-50" disabled={busy} onClick={discoverChats} type="button">{busy ? "正在刷新…" : "刷新群与权限"}</button>
        </div>
        <div aria-live="polite" className="border-b border-ops-line bg-[#fbfcfb] px-5 py-3 text-sm font-bold text-ops-muted">{status}</div>
        <div className="divide-y divide-ops-line">
          {groups.length ? groups.map((group) => <GroupCard group={group} key={group.chatId} />) : <div className="p-8 text-center font-bold text-ops-muted">尚未发现群。请确认三个 Bot 已入群并成为管理员。</div>}
        </div>
      </Card>
    </ConsoleShell>
  );
}

function GroupCard({ group }) {
  const bots = group.bots || [];
  const knownCount = group.topicCoverage?.knownCount ?? group.topics?.length ?? 0;
  const resolvedCount = group.topicCoverage?.resolvedCount ?? group.topics?.filter((topic) => topic.threadId).length ?? 0;
  return <article className="p-5">
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-black">{group.title}</h3><StatusPill tone={group.allBotsAdmin && group.canUseTopics ? "green" : "amber"}>{group.allBotsAdmin && group.canUseTopics ? "可运营" : "需处理"}</StatusPill></div><p className="mt-1 font-mono text-xs text-ops-muted">{group.chatId} · {group.type}</p></div>
      <div className="grid gap-2 text-sm sm:grid-cols-2 xl:min-w-[520px] xl:grid-cols-3">
        {(bots.length ? bots : [{ name: "AdminBot" }, { name: "SpeakerBot" }, { name: "ForwardBot" }]).map((bot) => <div className="rounded-lg border border-ops-line p-3" key={bot.name}><div className="font-black">{bot.name}</div><div className={`mt-1 text-xs font-bold ${bot.isAdmin ? "text-ops-accent" : "text-[#a04a3d]"}`}>{bot.isAdmin ? `管理员${bot.canManageTopics ? " · 可管理 Topic" : ""}` : bot.membership === "member" ? "已入群，非管理员" : "未确认权限"}</div></div>)}
      </div>
    </div>
    <div className="mt-4 rounded-lg bg-[#f7f9f8] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">Topics：{knownCount} 个已知 / {resolvedCount} 个已确认</strong><span className="text-xs text-ops-muted">{group.canUseTopics ? "Topics 已开启" : "Topics 未开启"}</span></div><div className="mt-3 flex flex-wrap gap-2">{(group.topics || []).map((topic) => <span className={`rounded-full px-3 py-1 text-xs font-bold ${topic.threadId ? "bg-[#e6f7ef] text-ops-accent" : "bg-[#fff1df] text-[#8a5d1a]"}`} key={`${topic.name}-${topic.threadId || "template"}`}>{topic.name}{topic.threadId ? ` · ${topic.threadId}` : " · 待识别"}</span>)}</div></div>
  </article>;
}

function Metric({ label, value, detail }) {
  return <div className="border-b border-ops-line p-5 last:border-0 sm:border-r xl:border-b-0"><div className="text-sm font-bold text-ops-muted">{label}</div><div className="mt-1 text-2xl font-black">{value}</div><div className="mt-1 text-xs text-ops-muted">{detail}</div></div>;
}
