"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import LiveStatusStamp from "../components/LiveStatusStamp";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../components/ui";
import { useLiveAutoRefresh } from "../hooks/useLiveAutoRefresh";
import { getLiveFreshness } from "../../lib/live-status.mjs";

export default function GroupConfigPage() {
  const [groups, setGroups] = useState([]);
  const [status, setStatus] = useState("正在读取已保存群配置…");
  const [busy, setBusy] = useState(false);
  const [manualChatId, setManualChatId] = useState("");
  const [generatedAt, setGeneratedAt] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [publisher, setPublisher] = useState(null);

  useEffect(() => {
    loadSavedGroups().finally(() => Promise.all([
      refreshLiveGroups({ silent: true }),
      loadPublisherStatus()
    ]));
  }, []);
  useLiveAutoRefresh(() => Promise.all([
    refreshLiveGroups({ silent: true }),
    loadPublisherStatus()
  ]), { enabled: !busy });

  async function loadSavedGroups() {
    try {
      const response = await fetch("/api/group-config", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "群配置读取失败");
      setGroups(data.groups || []);
      setStatus(data.groups?.length ? `已读取 ${data.groups.length} 个 Telegram 对象；当前只允许 Forum 群 / Topic 作为出站目标。` : "暂无已保存群，请刷新 Telegram 列表。");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function loadPublisherStatus() {
    try {
      const response = await fetch("/api/distribution", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "发布账号状态读取失败");
      setPublisher(data.publisher || null);
    } catch (error) {
      setPublisher({ mode: "user", ready: false, username: "@Serenity_Crypto", lastError: error.message });
    }
  }

  async function refreshLiveGroups({ silent = false, persist = false } = {}) {
    if (!silent) {
      setBusy(true);
      setStatus("正在通过 Telegram 事件和权限接口复核…");
    }
    try {
      const response = await fetch(`/api/chats?refresh=${Date.now()}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Telegram 群 / Channel 发现失败");
      let nextGroups = data.chats || [];
      let saveResult = null;
      if (persist) {
        const saveResponse = await fetch("/api/group-config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ groups: nextGroups, mode: "telegram-refresh" })
        });
        saveResult = await saveResponse.json();
        if (!saveResponse.ok || !saveResult.ok) throw new Error(saveResult.error || "群配置保存失败");
        nextGroups = saveResult.groups || nextGroups;
      }
      setGroups(nextGroups);
      setGeneratedAt(data.generatedAt || new Date().toISOString());
      setRefreshError("");
      const forumCount = nextGroups.filter((group) => group.canUseTopics).length;
      const channelCount = nextGroups.filter((group) => group.type === "channel").length;
      setStatus(saveResult?.preservedExisting
        ? saveResult.warning
        : `已实时核验 ${nextGroups.length} 个群 / Channel：${forumCount} 个 Forum 群，${channelCount} 个 Channel${persist ? "，并已保存" : ""}。`);
    } catch (error) {
      setRefreshError(error.message);
      if (!silent) setStatus(`刷新失败：${error.message}`);
    } finally {
      if (!silent) setBusy(false);
    }
  }

  function discoverChats() {
    return refreshLiveGroups({ persist: true });
  }

  async function probeAndSaveChat() {
    if (busy) return;
    const normalizedChatId = manualChatId.trim();
    if (!/^-100\d+$/.test(normalizedChatId)) {
      setStatus("请输入以 -100 开头的 Telegram Forum 超级群 ID。");
      return;
    }
    setBusy(true);
    setStatus("正在由服务器上的三个 Bot 检查群、Topics 与管理员权限…");
    try {
      const response = await fetch("/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: normalizedChatId })
      });
      const data = await response.json();
      if (!response.ok || !data.ok || !data.group) throw new Error(data.error || "群 / Channel 检测失败");
      if (data.group.type === "channel") throw new Error("当前发布模式仅支持 Forum 群；Channel 不会被保存为出站目标。");
      const mergedGroups = [data.group, ...groups.filter((group) => String(group.chatId) !== normalizedChatId)];
      const saveResponse = await fetch("/api/group-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groups: mergedGroups })
      });
      const saved = await saveResponse.json();
      if (!saveResponse.ok || !saved.ok) throw new Error(saved.error || "群配置保存失败");
      setGroups(saved.groups || mergedGroups);
      setGeneratedAt(data.generatedAt || new Date().toISOString());
      setRefreshError("");
      setManualChatId("");
      const readiness = data.group.canUseTopics ? "Topics 已开启" : "Topics 未开启";
      setStatus(`${data.group.title} 已检测并保存：三个 Bot 管理员 ${data.group.adminBotCount}/3，${readiness}。`);
    } catch (error) {
      setStatus(`检测失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  const topicCount = groups.reduce((total, group) => total + (group.topics?.length || 0), 0);
  const confirmedTopics = groups.reduce((total, group) => total + (group.topics?.filter((topic) => topic.threadId).length || 0), 0);
  const channels = groups.filter((group) => group.type === "channel");
  const freshness = getLiveFreshness(generatedAt);
  const liveIsFresh = freshness.state === "fresh";
  const publisherIsBot = publisher?.mode === "bot";
  const publisherIsDesktop = publisher?.mode === "desktop";
  const publisherName = publisher?.username || "@Serenity_Crypto";
  const publisherStatus = publisher?.ready
    ? publisherIsDesktop ? "本机官方群身份在线" : publisherIsBot ? "旧 Bot 模式已禁用" : "群官方身份已授权"
    : publisherIsDesktop ? "本机发布桥接离线" : "群官方发布器未就绪";
  const publisherDetail = publisherIsDesktop && publisher?.lastSeenAt
    ? `${publisherName} · 最近心跳 ${new Date(publisher.lastSeenAt).toLocaleString("zh-CN", { hour12: false })}`
    : `${publisherName} · ${publisher?.approvedTargetIds?.length || 0} 个白名单目标`;

  return (
    <ConsoleShell>
      <PageHeader
        title="群与 Topic 配置"
        desc={`这里只维护 Forum 群、Topic 与三个 Bot 的发现和权限状态；${publisherName} 仅作签名授权，消息必须显示目标群名称和群头像。`}
        action={<div className="flex flex-wrap gap-3"><Link className="grid min-h-11 place-items-center rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent" href="/telegram-user-authorization">授权群官方发布</Link><Link className="grid min-h-11 place-items-center rounded-lg bg-ops-accent px-5 text-sm font-black text-white" href="/distribution">进入内容分发中心</Link></div>}
      />

      <section className="mb-5 grid overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="已识别对象" value={groups.length} detail="跨设备持久保存" />
        <Metric label="Forum 群" value={groups.filter((group) => group.canUseTopics).length} detail={liveIsFresh ? "已实时核验 Topics 开关" : "状态已过期，等待刷新"} />
        <Metric label="历史 Channel" value={channels.length} detail="当前不作为出站目标" />
        <Metric label="Topic 总数" value={topicCount} detail={`${confirmedTopics} 个已确认 Thread ID`} />
        <Metric label="发布器" value={publisherStatus} detail={publisherDetail} />
      </section>

      <Card className="overflow-hidden">
        <div className="border-b border-ops-line bg-[#f7faf8] p-5">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <Field label="新 Forum 群 ID">
              <input className={`${inputClass} w-full`} value={manualChatId} onChange={(event) => setManualChatId(event.target.value)} placeholder="-100xxxxxxxxxx" />
            </Field>
            <button className="min-h-11 rounded-lg bg-ops-accent px-5 text-sm font-black text-white disabled:opacity-50" disabled={busy} onClick={probeAndSaveChat} type="button">{busy ? "正在检测…" : "按群 ID 检测并保存"}</button>
          </div>
          <p className="mt-2 text-xs font-bold text-ops-muted">无需在这台 Mac 登录三个 Bot。服务器通过 Bot API 检查群、Topics 与 Bot 管理员权限；实际出站由已授权的 @Serenity_Crypto 以匿名管理员身份签名，并强制使用目标群官方身份。首次登记请填写以 -100 开头的群 ID。</p>
        </div>
        <div className="flex flex-col gap-4 border-b border-ops-line p-5 md:flex-row md:items-center md:justify-between">
          <div><h2 className="text-xl font-black">Telegram 群与 Topic 健康状态</h2><p className="mt-1 text-sm text-ops-muted">刷新用于复核已登记对象；ForwardBot 启用 Webhook 后不再与 getUpdates 并行轮询。</p></div>
          <button className="min-h-11 rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent disabled:opacity-50" disabled={busy} onClick={discoverChats} type="button">{busy ? "正在刷新…" : "刷新群、Topic 与权限"}</button>
        </div>
        <div aria-live="polite" className="border-b border-ops-line bg-[#fbfcfb] px-5 py-3 text-sm font-bold text-ops-muted">{status}</div>
        <div className="border-b border-ops-line px-5 py-3"><LiveStatusStamp generatedAt={generatedAt} error={refreshError} refreshing={busy} /></div>
        <div className="divide-y divide-ops-line">
          {groups.length ? groups.map((group) => <GroupCard group={group} isFresh={liveIsFresh} key={group.chatId} publisher={publisher} />) : <div className="p-8 text-center font-bold text-ops-muted">尚未发现 Forum 群。请确认三个 Bot 已加入并获得对应管理员权限。</div>}
        </div>
      </Card>
    </ConsoleShell>
  );
}

function GroupCard({ group, isFresh, publisher }) {
  const bots = group.bots || [];
  const knownCount = group.topicCoverage?.knownCount ?? group.topics?.length ?? 0;
  const resolvedCount = group.topicCoverage?.resolvedCount ?? group.topics?.filter((topic) => topic.threadId).length ?? 0;
  const isChannel = group.type === "channel";
  const healthy = isChannel ? false : group.readyForInitialization === true;
  const targetApproved = publisher?.approvedTargetIds?.map(String).includes(String(group.chatId)) === true;
  const publisherReadyForTarget = publisher?.ready === true && targetApproved;
  return <article className="p-5">
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-black">{group.title}</h3><StatusPill tone={isFresh && healthy ? "green" : "amber"}>{!isFresh ? "状态已过期" : healthy ? "Bot 权限正常" : "Bot 权限需处理"}</StatusPill></div><p className="mt-1 font-mono text-xs text-ops-muted">{group.chatId} · {isChannel ? group.isPrivateChannel ? "private channel" : "public channel" : group.type}</p></div>
      <div className="grid gap-2 text-sm sm:grid-cols-2 xl:min-w-[520px] xl:grid-cols-3">
        {(bots.length ? bots : [{ name: "AdminBot" }, { name: "SpeakerBot" }, { name: "ForwardBot" }]).map((bot) => {
          const permissionLabel = !isFresh
            ? "等待重新核验"
            : !bot.isAdmin
              ? bot.membership === "member" ? "已加入，非管理员" : "未确认权限"
              : isChannel
                ? "管理员 · 仅保留识别"
                : `管理员${bot.canManageTopics ? " · 可管理 Topic" : ""}`;
          return <div className="rounded-lg border border-ops-line p-3" key={bot.name}><div className="font-black">{bot.name}</div><div className={`mt-1 text-xs font-bold ${isFresh && bot.isAdmin ? "text-ops-accent" : "text-[#a04a3d]"}`}>{permissionLabel}</div></div>;
        })}
      </div>
    </div>
    {isChannel
      ? <div className="mt-4 rounded-lg bg-[#fff8e8] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">历史 Channel 记录</strong><span className="text-xs font-bold text-[#a04a3d]">当前不作为出站目标</span></div><p className="mt-2 text-xs leading-5 text-ops-muted">当前工作流已收敛到 Forum Group + Topic。该 Channel 仅保留为历史识别数据，不会被自动发布或广播规则选为目标。</p></div>
      : <div className="mt-4 rounded-lg bg-[#f7f9f8] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">Topics：{knownCount} 个已知 / {resolvedCount} 个已确认</strong><span className={`text-xs font-bold ${publisherReadyForTarget ? "text-ops-accent" : "text-[#a04a3d]"}`}>{publisherReadyForTarget ? "群官方身份可用" : targetApproved ? "群已在白名单，发布授权待恢复" : "群尚未加入发布白名单"}</span></div><p className="mt-2 text-xs leading-5 text-ops-muted">出站消息由 {publisher?.username || "@Serenity_Crypto"} 作为匿名管理员授权，但 Telegram 客户端必须显示本群名称和群头像；若无法取得本群的 send_as 权限，系统会拒绝发送且不会回退到 Bot 或个人身份。</p><div className="mt-3 flex flex-wrap gap-2">{(group.topics || []).map((topic) => <span className={`rounded-full px-3 py-1 text-xs font-bold ${topic.threadId ? "bg-[#e6f7ef] text-ops-accent" : "bg-[#fff1df] text-[#8a5d1a]"}`} key={`${topic.name}-${topic.threadId || "template"}`}>{topic.name}{topic.threadId ? ` · ${topic.threadId}` : " · 待识别"}</span>)}</div>{publisher?.lastError ? <p className="mt-2 text-xs font-bold text-[#6f551d]">群官方发布器：{publisher.lastError}</p> : null}</div>}
  </article>;
}

function Metric({ label, value, detail }) {
  return <div className="border-b border-ops-line p-5 last:border-0 sm:border-r xl:border-b-0"><div className="text-sm font-bold text-ops-muted">{label}</div><div className="mt-1 text-2xl font-black">{value}</div><div className="mt-1 text-xs text-ops-muted">{detail}</div></div>;
}
