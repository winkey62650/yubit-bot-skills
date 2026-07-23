"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import LiveStatusStamp from "../components/LiveStatusStamp";
import { useLiveAutoRefresh } from "../hooks/useLiveAutoRefresh";
import { Card, PageHeader, StatusPill } from "../components/ui";
import { buildPublisherStatusChecks } from "../../lib/distribution-ui.mjs";
import { PUBLISHER_HEARTBEAT_STALE_MS } from "../../lib/live-status.mjs";

const DEMO_CHAT_ID = "-1003710405969";

export default function TelegramUserAuthorizationPage() {
  const [publisher, setPublisher] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/distribution", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "发布账号状态检测失败");
      setPublisher(data.publisher || null);
      setError("");
    } catch (nextError) {
      setError(nextError.message || "发布账号状态检测失败");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useLiveAutoRefresh(() => refresh({ silent: true }), { enabled: !loading });

  const operationalStatus = publisher?.operationalStatus || "offline";
  const ready = publisher?.operationalReady === true;
  const statusLabel = loading ? "正在核验"
    : operationalStatus === "publishing"
    ? "正在发布"
    : operationalStatus === "stalled"
      ? "任务卡住"
      : operationalStatus === "degraded"
        ? "最近发布失败"
        : ready
          ? "在线"
          : "离线";
  const approvedTargets = publisher?.approvedTargetIds || [];
  const lastSeenAt = publisher?.lastSeenAt || publisher?.lastVerifiedAt || null;
  const checks = buildPublisherStatusChecks(publisher || {});
  const allChecksHealthy = !loading && checks.every((check) => check.ok !== false);

  return (
    <ConsoleShell>
      <PageHeader
        title="发布账号状态检测"
        desc="实时核验 @Serenity_Crypto、Telegram 会话、本机发布桥、目标白名单和最近一次投递；这里不保存账号密码或开发凭证。"
        action={<Link className="grid min-h-11 place-items-center rounded-lg bg-ops-accent px-5 text-sm font-black text-white" href="/distribution">进入内容分发中心</Link>}
      />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <LiveStatusStamp generatedAt={lastSeenAt} error={error} refreshing={loading} staleAfterMs={PUBLISHER_HEARTBEAT_STALE_MS} />
        <button className="min-h-11 rounded-lg border border-ops-accent bg-white px-5 text-sm font-black text-ops-accent disabled:opacity-50" disabled={loading} onClick={() => refresh()} type="button">
          {loading ? "正在核验" : "刷新运行状态"}
        </button>
      </div>

      <section className="mb-5 grid overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="主发布账号" value={loading ? "—" : publisher?.username || "@Serenity_Crypto"} ok={!loading} />
        <Metric label="本机发布桥" value={statusLabel} ok={ready || operationalStatus === "publishing"} />
        <Metric label="已授权目标" value={loading ? "—" : `${approvedTargets.length} 个`} ok={!loading && approvedTargets.length > 0} />
        <Metric label="安全回退" value="禁止 Bot / 个人身份" ok />
      </section>

      {(error || publisher?.operationalError) ? (
        <div className="mb-5 rounded-lg border border-[#e4c88b] bg-[#fff7e6] px-4 py-3 text-sm font-bold text-[#80591c]" role="alert">
          {error || publisher.operationalError}
        </div>
      ) : null}

      <Card className="mb-5 overflow-hidden">
        <div className="border-b border-ops-line p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-black">实时检测项</h2>
              <p className="mt-1 text-sm text-ops-muted">账号身份、本机发布桥、Telegram 会话、目标白名单和最近一次投递分别检测，不再用单一“在线”状态掩盖局部故障。</p>
            </div>
            <StatusPill tone={allChecksHealthy ? "green" : "amber"}>{allChecksHealthy ? "检测通过" : "需要处理"}</StatusPill>
          </div>
        </div>
        <div className="grid divide-y divide-ops-line md:grid-cols-2 md:divide-x md:divide-y-0 xl:grid-cols-5">
          {checks.map((check) => <StatusCheck check={check} key={check.key} />)}
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">检测通过后的发布闭环</h2>
            <p className="mt-1 text-sm text-ops-muted">运营只需要维护内容规则、目标群和 Topic，不再处理账号开发凭证或选择 Bot 发送人。</p>
          </div>
          <StatusPill tone={allChecksHealthy ? "green" : "amber"}>{allChecksHealthy ? "闭环在线" : "闭环待恢复"}</StatusPill>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Step number="1" title="生成内容" text="自动任务、广播或 Trader 信号进入服务端发布队列。" />
          <Step number="2" title="安全领取" text="本机发布桥单实例领取任务，防止重复发布。" />
          <Step number="3" title="官方群身份发布" text="@Serenity_Crypto 选择目标群身份与正确 Topic，严格按模板发送。" />
          <Step number="4" title="结果回写" text="逐步回写消息编号、成功状态或可重试错误。" />
        </div>
      </Card>

      <Card className="mt-5 p-6">
        <h2 className="text-xl font-black">发布边界</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <Scope title="当前验收群" value="Demo Academy Forum" />
          <Scope title="Telegram Chat ID" value={DEMO_CHAT_ID} mono />
          <Scope title="显示效果" value="群名称和群头像，不显示 Bot 或个人账号" />
        </div>
        <p className="mt-4 text-sm leading-6 text-ops-muted">只有白名单内、且 @Serenity_Crypto 已设为匿名管理员 / Send As 群身份的 Forum 群可以发布。新增正式群必须先在“群与 Topic”完成权限核验，再明确批准加入白名单。</p>
      </Card>

      <Card className="mt-5 p-6">
        <h2 className="text-xl font-black">后台能力组件仍然保留</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <Scope title="AdminBot" value="群发现、Topic 初始化、权限复核" />
          <Scope title="SpeakerBot" value="Trader 私聊接收、订单核验" />
          <Scope title="ForwardBot" value="来源群 / Channel 新消息监听" />
        </div>
        <p className="mt-4 text-sm leading-6 text-ops-muted">三个 Bot 是后台能力组件，不是可见发言人。它们保留原功能，但所有获准的出站内容都统一进入 @Serenity_Crypto 发布队列。</p>
      </Card>
    </ConsoleShell>
  );
}

function Metric({ label, value, ok }) {
  return <div className="border-b border-ops-line p-5 last:border-0 sm:border-r xl:border-b-0"><div className="text-sm font-bold text-ops-muted">{label}</div><div className={`mt-1 text-xl font-black ${ok ? "text-ops-accent" : "text-[#8a5d1a]"}`}>{value}</div></div>;
}

function StatusCheck({ check }) {
  const stateClass = check.ok === true ? "text-ops-accent" : check.ok === false ? "text-[#9a5f31]" : "text-ops-muted";
  return <div className="min-w-0 p-5"><div className="text-xs font-black uppercase tracking-wide text-ops-muted">{check.label}</div><div className={`mt-2 text-lg font-black ${stateClass}`}>{check.status}</div><p className="mt-2 break-words text-xs leading-5 text-ops-muted">{check.detail}</p></div>;
}

function Step({ number, title, text }) {
  return <div className="rounded-lg bg-[#f7f9f8] p-4"><span className="grid h-7 w-7 place-items-center rounded-full bg-ops-accent text-xs font-black text-white">{number}</span><h3 className="mt-3 font-black">{title}</h3><p className="mt-1 text-sm leading-6 text-ops-muted">{text}</p></div>;
}

function Scope({ title, value, mono = false }) {
  return <div className="rounded-lg bg-[#f7f9f8] p-4"><div className="text-xs font-bold text-ops-muted">{title}</div><div className={`mt-1 font-black ${mono ? "font-mono" : ""}`}>{value}</div></div>;
}
