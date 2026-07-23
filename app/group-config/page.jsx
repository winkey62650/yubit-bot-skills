"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import LiveStatusStamp from "../components/LiveStatusStamp";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../components/ui";
import { useLiveAutoRefresh } from "../hooks/useLiveAutoRefresh";
import { getLiveFreshness } from "../../lib/live-status.mjs";
import { isRetiredTelegramGroup, normalizeDistributionGroupTopics } from "../../lib/distribution-ui.mjs";

export default function GroupConfigPage() {
  const [groups, setGroups] = useState([]);
  const [status, setStatus] = useState("正在读取已保存群配置…");
  const [busy, setBusy] = useState(false);
  const [manualChatId, setManualChatId] = useState("");
  const [generatedAt, setGeneratedAt] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [publisher, setPublisher] = useState(null);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [publisherLoaded, setPublisherLoaded] = useState(false);

  useEffect(() => {
    async function bootstrap() {
      await loadSavedGroups();
      await Promise.all([
        refreshLiveGroups({ silent: true }),
        loadPublisherStatus()
      ]);
    }
    bootstrap();
  }, []);
  useLiveAutoRefresh(() => Promise.all([
    refreshLiveGroups({ silent: true }),
    loadPublisherStatus()
  ]), { enabled: groupsLoaded && !busy });

  async function loadSavedGroups() {
    try {
      const response = await fetch("/api/group-config", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "群配置读取失败");
      setGroups(data.groups || []);
      setStatus(data.groups?.length ? `已读取 ${data.groups.length} 个 Telegram 对象；当前只允许 Forum 群 / Topic 作为出站目标。` : "暂无已保存群，请刷新 Telegram 列表。");
    } catch (error) {
      setStatus(error.message);
    } finally {
      setGroupsLoaded(true);
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
    } finally {
      setPublisherLoaded(true);
    }
  }

  async function refreshLiveGroups({ silent = false, persist = false } = {}) {
    if (!groupsLoaded && !silent) return;
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
      const retiredCount = nextGroups.filter((group) => group.type !== "channel" && isRetiredTelegramGroup(group)).length;
      const activeGroups = nextGroups.filter((group) => group.type !== "channel" && !isRetiredTelegramGroup(group));
      const forumCount = activeGroups.filter((group) => group.canUseTopics).length;
      const channelCount = nextGroups.filter((group) => group.type === "channel").length;
      setStatus(saveResult?.preservedExisting
        ? saveResult.warning
        : `已实时核验 ${activeGroups.length + channelCount} 个有效群 / Channel：${forumCount} 个 Forum 群，${channelCount} 个 Channel${retiredCount ? `；另有 ${retiredCount} 条失效历史群已隐藏` : ""}${persist ? "，并已保存" : ""}。`);
    } catch (error) {
      setRefreshError(error.message);
      if (!silent) setStatus(`刷新失败：${error.message}`);
    } finally {
      setGroupsLoaded(true);
      if (!silent) setBusy(false);
    }
  }

  function discoverChats() {
    return refreshLiveGroups({ persist: true });
  }

  async function probeAndSaveChat() {
    if (!groupsLoaded || busy) return;
    const normalizedChatId = manualChatId.trim();
    if (!/^-100\d+$/.test(normalizedChatId)) {
      setStatus("请输入以 -100 开头的 Telegram Forum 超级群 ID。");
      return;
    }
    setBusy(true);
    setStatus("正在由 AdminBot 检查群、Topics 与初始化权限…");
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
      const readiness = data.group.adminBotReady
        ? "AdminBot 初始化权限已通过"
        : data.group.initializationBlockReason || "AdminBot 初始化权限待处理";
      setStatus(`${data.group.title} 已检测并保存：${readiness}。`);
    } catch (error) {
      setStatus(`检测失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  const retiredGroups = groups.filter((group) => group.type !== "channel" && isRetiredTelegramGroup(group));
  const forumGroups = groups.filter((group) => group.type !== "channel" && !isRetiredTelegramGroup(group));
  const normalizedForumTopics = forumGroups.map((group) => normalizeDistributionGroupTopics(group));
  const topicCount = normalizedForumTopics.reduce((total, topics) => total + topics.length, 0);
  const confirmedTopics = normalizedForumTopics.reduce(
    (total, topics) => total + topics.filter((topic) => Number(topic.threadId || topic.topicId) > 0).length,
    0
  );
  const channels = groups.filter((group) => group.type === "channel");
  const freshness = getLiveFreshness(generatedAt);
  const liveIsFresh = freshness.state === "fresh";
  const publisherIsDesktop = publisher?.mode === "desktop";
  const publisherName = publisher?.username || "@Serenity_Crypto";
  const publisherBridgeActive = publisher?.bridgeActive == null
    ? publisher?.authorized === true
    : publisher.bridgeActive === true;
  const demoAuthorized = publisher?.approvedTargetIds?.map(String).includes("-1003710405969") === true;
  const publisherStatus = demoAuthorized ? "Demo Academy 已授权" : "Demo Academy 未授权";
  const publisherDetail = publisherBridgeActive
    ? `本机发布桥在线${publisherIsDesktop && publisher?.lastSeenAt ? ` · 最近心跳 ${new Date(publisher.lastSeenAt).toLocaleString("zh-CN", { hour12: false })}` : ""}`
    : "本机发布桥离线";

  return (
    <ConsoleShell>
      <PageHeader
        title="群与 Topic 配置"
        desc={`主工作流：@Serenity_Crypto → 已授权群组 → Topic → 自动发布。${publisherName} 是唯一主发布账号，对外显示目标群身份；AdminBot 只负责群发现、Topic 初始化和权限复核，SpeakerBot / ForwardBot 的后台能力保持不变。`}
        action={<div className="flex flex-wrap gap-3"><Link className="grid min-h-11 place-items-center rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent" href="/telegram-user-authorization">授权群官方发布</Link><Link className="grid min-h-11 place-items-center rounded-lg bg-ops-accent px-5 text-sm font-black text-white" href="/distribution">进入内容分发中心</Link></div>}
      />

      <section className="mb-5 grid overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="已识别群" value={groupsLoaded ? forumGroups.length : "—"} detail={groupsLoaded ? "跨设备持久保存" : "正在读取已保存群"} />
        <Metric label="初始化就绪" value={groupsLoaded ? forumGroups.filter((group) => group.adminBotReady).length : "—"} detail={!groupsLoaded ? "正在读取群权限" : liveIsFresh ? "已实时核验 AdminBot" : "状态已过期，等待刷新"} />
        <Metric label="Topic 总数" value={groupsLoaded ? topicCount : "—"} detail={groupsLoaded ? `${confirmedTopics} 个已确认 Thread ID` : "正在读取 Topic"} />
        <Metric label="主发布账号" value={publisherLoaded ? publisherStatus : "—"} detail={publisherLoaded ? publisherDetail : "正在核验发布桥"} />
      </section>

      <Card className="overflow-hidden">
        <div className="border-b border-ops-line bg-[#f7faf8] p-5">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <Field label="新 Forum 群 ID">
              <input className={`${inputClass} w-full`} disabled={!groupsLoaded || busy} value={manualChatId} onChange={(event) => setManualChatId(event.target.value)} placeholder="-100xxxxxxxxxx" />
            </Field>
            <button className="min-h-11 rounded-lg bg-ops-accent px-5 text-sm font-black text-white disabled:opacity-50" disabled={!groupsLoaded || busy} onClick={probeAndSaveChat} type="button">{busy ? "正在检测…" : groupsLoaded ? "按群 ID 检测并保存" : "正在读取群配置…"}</button>
          </div>
          <p className="mt-2 text-xs font-bold text-ops-muted">无需在这台 Mac 登录 Bot。AdminBot 通过 Bot API 检查群、Topics 与初始化权限；@Serenity_Crypto 必须是目标群管理员并进入发布白名单。实际出站使用匿名管理员 / Send As 能力，强制显示目标群名称和群头像。首次登记请填写以 -100 开头的群 ID。</p>
        </div>
        <div className="flex flex-col gap-4 border-b border-ops-line p-5 md:flex-row md:items-center md:justify-between">
          <div><h2 className="text-xl font-black">目标群与 Topic 健康状态</h2><p className="mt-1 text-sm text-ops-muted">刷新用于复核 AdminBot 初始化权限、Topic Thread ID 和主发布账号白名单。{channels.length || retiredGroups.length ? `已隐藏 ${channels.length} 条历史 Channel 和 ${retiredGroups.length} 条失效群记录，当前不作为出站目标。` : ""}</p></div>
          <button className="min-h-11 rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent disabled:opacity-50" disabled={!groupsLoaded || busy} onClick={discoverChats} type="button">{busy ? "正在刷新…" : "刷新群、Topic 与权限"}</button>
        </div>
        <div aria-live="polite" className="border-b border-ops-line bg-[#fbfcfb] px-5 py-3 text-sm font-bold text-ops-muted">{status}</div>
        <div className="border-b border-ops-line px-5 py-3"><LiveStatusStamp generatedAt={generatedAt} error={refreshError} refreshing={busy} /></div>
        {publisherLoaded && publisher?.lastError ? <div className="border-b border-[#f0d99f] bg-[#fff7e7] px-5 py-3 text-sm font-bold text-[#6f551d]">发布桥最近一次投递失败：{publisher.lastError}</div> : null}
        <div className="divide-y divide-ops-line">
          {!groupsLoaded || !publisherLoaded
            ? <div className="p-8 text-center font-bold text-ops-muted">正在读取群、Topic 与发布账号状态…</div>
            : forumGroups.length
              ? forumGroups.map((group) => <GroupCard group={group} isFresh={liveIsFresh} key={group.chatId} publisher={publisher} />)
              : <div className="p-8 text-center font-bold text-ops-muted">尚未发现 Forum 群。请确认 @Serenity_Crypto 与 AdminBot 已加入目标群并设为管理员。</div>}
        </div>
      </Card>
    </ConsoleShell>
  );
}

function GroupCard({ group, isFresh, publisher }) {
  const bots = group.bots || [];
  const adminBot = bots.find((bot) => bot.name === "AdminBot") || {};
  const topics = normalizeDistributionGroupTopics(group);
  const knownCount = topics.length;
  const resolvedCount = topics.filter((topic) => Number(topic.threadId || topic.topicId) > 0).length;
  const healthy = group.adminBotReady === true || group.readyForInitialization === true;
  const targetApproved = publisher?.approvedTargetIds?.map(String).includes(String(group.chatId)) === true;
  const bridgeActive = publisher?.bridgeActive == null
    ? publisher?.authorized === true
    : publisher.bridgeActive === true;
  const targetName = String(group.chatId) === "-1003710405969" ? "Demo Academy" : group.title || "目标群";
  const authorizationLabel = targetApproved ? `${targetName} 已授权` : `${targetName} 未授权`;
  const bridgeLabel = bridgeActive ? "本机发布桥在线" : "本机发布桥离线";
  return <article className="p-5">
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-black">{group.title}</h3><StatusPill tone={isFresh && healthy ? "green" : "amber"}>{!isFresh ? "状态已过期" : healthy ? "初始化能力正常" : "初始化权限需处理"}</StatusPill></div><p className="mt-1 font-mono text-xs text-ops-muted">{group.chatId} · {group.type}</p></div>
      <div className="grid gap-2 text-sm sm:grid-cols-2 xl:min-w-[520px]">
        <div className="rounded-lg border border-ops-line p-3"><div className="font-black">主发布账号</div><div className={`mt-1 text-xs font-bold ${targetApproved ? "text-ops-accent" : "text-[#a04a3d]"}`}>{publisher?.username || "@Serenity_Crypto"} · {authorizationLabel}</div><div className={`mt-1 text-xs font-bold ${bridgeActive ? "text-ops-accent" : "text-[#a04a3d]"}`}>{bridgeLabel}</div></div>
        <div className="rounded-lg border border-ops-line p-3"><div className="font-black">初始化执行器</div><div className={`mt-1 text-xs font-bold ${isFresh && healthy ? "text-ops-accent" : "text-[#a04a3d]"}`}>AdminBot · {!isFresh ? "等待重新核验" : healthy ? "权限完整" : adminBot.membership === "member" ? "已加入，非管理员" : group.initializationBlockReason || "权限待处理"}</div></div>
      </div>
    </div>
    <div className="mt-4 rounded-lg bg-[#f7f9f8] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">Topics：{knownCount} 个已知 / {resolvedCount} 个已确认</strong><div className="flex flex-wrap gap-3"><span className={`text-xs font-bold ${targetApproved ? "text-ops-accent" : "text-[#a04a3d]"}`}>{authorizationLabel}</span><span className={`text-xs font-bold ${bridgeActive ? "text-ops-accent" : "text-[#a04a3d]"}`}>{bridgeLabel}</span></div></div><p className="mt-2 text-xs leading-5 text-ops-muted">出站消息由 {publisher?.username || "@Serenity_Crypto"} 通过本群的匿名管理员 / Send As 能力发布，Telegram 客户端必须显示本群名称和群头像；若无法取得权限，系统会拒绝发送且不会回退到 Bot 或个人身份。</p><div className="mt-3 flex flex-wrap gap-2">{topics.map((topic) => { const threadId = Number(topic.threadId || topic.topicId); return <span className={`rounded-full px-3 py-1 text-xs font-bold ${threadId > 0 ? "bg-[#e6f7ef] text-ops-accent" : "bg-[#fff1df] text-[#8a5d1a]"}`} key={`${topic.name}-${threadId || "template"}`}>{topic.name}{threadId > 0 ? ` · ${threadId}` : " · 待识别"}</span>; })}</div></div>
  </article>;
}

function Metric({ label, value, detail }) {
  return <div className="border-b border-ops-line p-5 last:border-0 sm:border-r xl:border-b-0"><div className="text-sm font-bold text-ops-muted">{label}</div><div className="mt-1 text-2xl font-black">{value}</div><div className="mt-1 text-xs text-ops-muted">{detail}</div></div>;
}
