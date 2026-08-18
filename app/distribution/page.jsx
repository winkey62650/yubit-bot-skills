"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ConsoleShell from "../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../components/ui";
import SocialSourceManager from "./SocialSourceManager";
import SiteAnalyticsPanel from "./SiteAnalyticsPanel";
import { loadWorkspaceState, saveWorkspaceState } from "../../lib/workspace-client";
import {
  applyDistributionTopicMappings,
  bulkDeleteNotice,
  buildBroadcastRouteSummary,
  buildDistributionSourceOptions,
  buildDistributionTargetOptions,
  buildDiscordDistributionTargetOptions,
  buildSocialSourceReadiness,
  buildSocialSourceRouteReadiness,
  distributionDestinationLabel,
  failedBulkDeleteIds,
  filterBroadcastTargetOptions,
  getContentTemplate,
  reconcileRuleSelection,
  recommendedScheduleFor
} from "../../lib/distribution-ui.mjs";

const tabs = [
  ["site-analytics", "网站数据"],
  ["automation", "自动发布"],
  ["destination-cta", "频道 CTA"],
  ["broadcast", "内容同步"],
  ["review", "待审核"],
  ["logs", "运行记录"]
];

const contentTypes = [
  ["news", "Crypto News"],
  ["daily-events", "Daily Events"],
  ["daily-analysis", "Daily Analysis"],
  ["whale-signals", "大户挂单 & 巨鲸数据"],
  ["agent-sync", "代理群信息更新"]
];

const schedules = [
  ["every-5-minutes", "每 5 分钟"],
  ["every-15-minutes", "每 15 分钟"],
  ["hourly", "每小时"],
  ["every-4-hours", "每 4 小时"],
  ["daily-0800-utc", "每日 08:00 UTC"]
];

const DEMO_ACADEMY_CHAT_ID = "-1003710405969";
const defaultDeliverySettings = { telegramPublishMode: "bot", telegramForwardMode: "bot" };

const officialPublishingSteps = [
  "服务器生成带指纹的定稿模板并排队",
  "本机发布桥取得唯一租约，单实例领取",
  "Telegram Desktop 以目标群官方身份逐步发送",
  "每步回写检查点，完成后回写消息编号"
];

const botPublishingSteps = [
  "服务器生成带指纹的定稿模板并排队",
  "生产 Worker 取得唯一租约，单实例领取",
  "SpeakerBot 通过 Bot API 发布到选定目标群",
  "每步回写检查点，完成后回写消息编号"
];

const officialPublishingRoutes = [
  "Daily Events → 3. Market Events",
  "Daily Analysis → 4. Market Analysis - Crypto/Stocks/TradFi",
  "Whale Signals → 6. Smart Money Tracker"
];

const officialPublishingContracts = [
  {
    name: "Daily Events",
    output: "2 条 · 独立海报 + 独立英文正文",
    rule: "海报不得带 Caption；正文不得合并进图片消息。"
  },
  {
    name: "Daily Analysis",
    output: "1 条 · 海报与 Caption 同一条消息",
    rule: "英文模板逐字发布；禁止出现 OKX fallback。"
  },
  {
    name: "Whale Signals",
    output: "1 条 · 海报与 Caption 同一条消息",
    rule: "Caption 必须为英文；禁止出现 Data Source 和 Hashtag。"
  }
];

const emptyAutomation = { id: "", kind: "automation", name: "", contentType: "daily-events", schedulePreset: "daily-0800-utc", enabled: true, targets: [], targetCtas: {} };
const emptyBroadcast = { id: "", kind: "broadcast", name: "", mode: "automatic", enabled: true, source: { chatId: "", chatType: "supergroup", threadId: "", groupName: "", topicName: "" }, targets: [] };

export default function DistributionPage() {
  return <Suspense fallback={<ConsoleShell><Card className="p-8 text-center font-bold text-ops-muted">正在加载内容分发中心…</Card></ConsoleShell>}>
    <DistributionPageContent />
  </Suspense>;
}

function DistributionPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedView = searchParams.get("view");
  const requestedContentType = searchParams.get("contentType");
  const view = tabs.some(([key]) => key === requestedView) ? requestedView : "automation";
  const [data, setData] = useState({ rules: [], review: [], deliveries: [], database: null, publisher: null, migration: null });
  const [groups, setGroups] = useState([]);
  const [discordState, setDiscordState] = useState({ guilds: [], config: { guilds: {} } });
  const [socialPackages, setSocialPackages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [automationForm, setAutomationForm] = useState(emptyAutomation);
  const [broadcastForm, setBroadcastForm] = useState(emptyBroadcast);
  const [validation, setValidation] = useState(null);
  const [selectedAutomationRules, setSelectedAutomationRules] = useState([]);
  const [selectedBroadcastRules, setSelectedBroadcastRules] = useState([]);
  const [selectedReviews, setSelectedReviews] = useState([]);
  const [backfill, setBackfill] = useState({ ruleId: "", references: "", preview: null });
  const [deliverySettings, setDeliverySettings] = useState(defaultDeliverySettings);
  const [targetPresets, setTargetPresets] = useState([]);
  const [destinationCtas, setDestinationCtas] = useState({});

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    if (contentTypes.some(([key]) => key === requestedContentType)) {
      setAutomationForm((current) => ({
        ...current,
        contentType: requestedContentType,
        schedulePreset: recommendedScheduleFor(requestedContentType)
      }));
    }
  }, [requestedContentType]);

  async function loadAll() {
    setLoading(true);
    try {
      const overviewResponse = await fetch("/api/distribution", { cache: "no-store" });
      const overview = await overviewResponse.json();
      if (!overviewResponse.ok || !overview.ok) throw new Error(overview.error || "内容分发数据读取失败");

      // Rules and delivery history are the primary content of this page. Keep them
      // visible even when an optional catalogue or a saved UI preference is down.
      setData(overview);
      const firstBroadcast = overview.rules?.find((rule) => rule.kind === "broadcast");
      setBackfill((current) => ({ ...current, ruleId: current.ruleId || firstBroadcast?.id || "" }));

      const optionalResults = await Promise.allSettled([
        (async () => {
          const groupsResponse = await fetch("/api/group-config", { cache: "no-store" });
          const groupConfig = await groupsResponse.json();
          if (!groupsResponse.ok || !groupConfig.ok) throw new Error(groupConfig.error || "群与 Topic 数据读取失败");
          setGroups(applyDistributionTopicMappings(groupConfig.groups || [], overview.rules || []));
        })(),
        (async () => {
          const socialResponse = await fetch("/api/social-packages", { cache: "no-store" });
          const socialConfig = await socialResponse.json();
          if (!socialResponse.ok || !socialConfig.ok) throw new Error(socialConfig.error || "代理来源读取失败");
          setSocialPackages(Array.isArray(socialConfig.packages) ? socialConfig.packages : []);
        })(),
        (async () => {
          const savedSettings = await loadWorkspaceState("settings");
          setDeliverySettings({ ...defaultDeliverySettings, ...(savedSettings?.state || {}) });
        })(),
        (async () => {
          const savedPresets = await loadWorkspaceState("target-presets");
          setTargetPresets(savedPresets?.state?.presets || []);
        })(),
        (async () => {
          const response = await fetch("/api/discord", { cache: "no-store" });
          const discord = await response.json();
          if (!response.ok || !discord.ok) throw new Error(discord.error || "Discord Server 与 Channel 读取失败");
          setDiscordState(discord);
        })(),
        (async () => {
          const response = await fetch("/api/destination-cta", { cache: "no-store" });
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.error || "频道 CTA 读取失败");
          setDestinationCtas(result.registry || {});
        })()
      ]);
      const optionalLabels = ["群与 Topic", "代理来源", "发送身份", "目标预设", "Discord Server 与 Channel", "频道 CTA"];
      const failedOptionalLoads = optionalResults
        .map((result, index) => result.status === "rejected" ? optionalLabels[index] : "")
        .filter(Boolean);
      if (failedOptionalLoads.length > 0) {
        setNotice(`自动发布和内容同步规则已恢复显示；${failedOptionalLoads.join("、")}暂时读取失败，可稍后刷新重试。`);
      }
    } catch (error) {
      setNotice(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function saveDeliveryIdentity(field, value) {
    setBusy(`delivery-identity-${field}`);
    setNotice("");
    try {
      const saved = await saveWorkspaceState("settings", { ...deliverySettings, [field]: value });
      setDeliverySettings(saved.state);
      setNotice(`${field === "telegramPublishMode" ? "自动发布" : "内容同步"}已切换为${value === "bot" ? "Bot" : "真人 TG"}身份。`);
      await loadAll();
    } catch (error) {
      setNotice(`发送身份保存失败：${error.message}`);
    } finally {
      setBusy("");
    }
  }

  async function savePreset(name, targets) {
    setBusy("save-preset");
    setNotice("");
    try {
      const newPreset = { id: crypto.randomUUID(), name, targets };
      const nextPresets = [...targetPresets, newPreset];
      const saved = await saveWorkspaceState("target-presets", { presets: nextPresets });
      setTargetPresets(saved.state?.presets || []);
      setNotice(`已保存群组预设 "${name}"。`);
    } catch (error) {
      setNotice(`预设保存失败：${error.message}`);
    } finally {
      setBusy("");
    }
  }

  async function deletePreset(presetId) {
    setBusy("delete-preset");
    setNotice("");
    try {
      const nextPresets = targetPresets.filter(p => p.id !== presetId);
      const saved = await saveWorkspaceState("target-presets", { presets: nextPresets });
      setTargetPresets(saved.state?.presets || []);
      setNotice(`预设已删除。`);
    } catch (error) {
      setNotice(`预设删除失败：${error.message}`);
    } finally {
      setBusy("");
    }
  }

  async function saveSocialPackages(mutation, successMessage) {
    setBusy("social-packages");
    setNotice("");
    try {
      const response = await fetch("/api/social-packages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(mutation) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "代理来源保存失败");
      setSocialPackages(result.packages || []);
      setNotice(successMessage);
      return result;
    } catch (error) {
      setNotice(error.message);
      return null;
    } finally {
      setBusy("");
    }
  }

  async function saveDestinationCtas(configs) {
    setBusy("destination-cta");
    setNotice("");
    try {
      const response = await fetch("/api/destination-cta", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configs })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "频道 CTA 保存失败");
      setDestinationCtas(result.registry || {});
      setNotice("频道 CTA 已保存；后续手动和自动分发会按每个目标自动读取。");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy("");
    }
  }

  async function post(body, successMessage, refresh = true) {
    setBusy(body.action || "save");
    setNotice("");
    try {
      const response = await fetch("/api/distribution", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "操作失败");
      if (body.action === "run-now" && result.result?.status === "queued") {
        if (refresh) await loadAll();
        setNotice(result.result?.message || "内容已生成并排队，等待本机发布桥发送。");
        return result;
      }
      if (body.action === "run-now" && !["success", "queued"].includes(result.result?.status)) {
        if (refresh) await loadAll();
        const detail = result.result?.error || result.result?.run?.message || "请在运行记录中查看失败目标";
        throw new Error(result.result?.status === "partial" ? `部分目标发布失败：${detail}` : `自动发布失败：${detail}`);
      }
      setNotice(successMessage);
      if (refresh) await loadAll();
      return result;
    } catch (error) {
      setNotice(error.message);
      return null;
    } finally {
      setBusy("");
    }
  }

  async function saveRule(form, reset) {
    const resolvedTargets = resolveTargets(form.targets, form.kind);
    const targets = form.kind === "automation"
      ? resolvedTargets.map((target) => {
        const cta = normalizeFormTargetCta(form.targetCtas?.[targetKey(target)]);
        return cta.ctaEnabled || cta.ctaText || cta.ctaUrl ? { ...target, ...cta } : target;
      })
      : resolvedTargets;
    const { targetCtas, ...formWithoutTargetCtas } = form;
    const rule = { ...formWithoutTargetCtas, id: form.id || undefined, targets };
    const result = await post({ rule }, "规则已保存，并会在刷新、重新登录及重新部署后保持一致。");
    if (result) reset();
  }

  async function reviewAction(action, ids) {
    if (!ids.length) return;
    setBusy(`review-${action}`);
    try {
      const response = await fetch("/api/distribution/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ids }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "审核失败");
      setSelectedReviews([]);
      const failures = result.results?.filter((item) => !item.ok) || [];
      setNotice(failures.length
        ? `${result.results.length - failures.length} 条处理成功，${failures.length} 条失败：${failures.map((item) => item.error).join("；")}`
        : action === "approve" ? "已批准，内容只会投递一次。" : "已拒绝，不会自动发布。");
      await loadAll();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy("");
    }
  }

  async function validate(id) {
    const result = await post({ action: "validate", id }, "验证完成。", false);
    setValidation(result?.result || null);
  }

  async function previewBackfill(send = false) {
    setBusy("backfill");
    try {
      const response = await fetch("/api/distribution/backfill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ruleId: backfill.ruleId, references: backfill.references, preview: !send }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "历史补发失败");
      setBackfill((current) => ({ ...current, preview: result.result }));
      setNotice(send ? "人工回填已执行；各目标结果见预览区。" : "预览完成，请核对消息编号与目标后再确认补发。");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy("");
    }
  }

  async function deleteManyRules(ids, setSelected, kindLabel) {
    if (!ids.length || !window.confirm(`确认删除已选的 ${ids.length} 条${kindLabel}？此操作不可撤销。`)) return;
    setBusy(`delete-many-${kindLabel}`);
    setNotice("");
    try {
      const response = await fetch("/api/distribution", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete-many", ids })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "批量删除失败");
      setSelected(failedBulkDeleteIds(result));
      setNotice(bulkDeleteNotice(result));
      await loadAll();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy("");
    }
  }

  function changeView(next) {
    router.replace(`/distribution?view=${next}`, { scroll: false });
  }

  const automationRules = data.rules.filter((rule) => rule.kind === "automation");
  const broadcastRules = data.rules.filter((rule) => rule.kind === "broadcast");
  const socialReadiness = buildSocialSourceReadiness(socialPackages);
  const publisherIsBot = data.publisher?.mode === "bot";
  const publisherIsDesktop = data.publisher?.mode === "desktop";
  const automaticPublisherName = deliverySettings.telegramPublishMode === "bot" ? "@Satoshi_geniustrader_bot" : "@Serenity_Crypto";
  const forwardPublisherName = deliverySettings.telegramForwardMode === "bot" ? "@Biupa_geniustrader_bot" : "@Serenity_Crypto";
  const publisherName = deliverySettings.telegramForwardMode === "bot"
    ? forwardPublisherName
    : data.publisher?.username || forwardPublisherName;
  const operationalStatus = data.publisher?.operationalStatus || (data.publisher?.ready ? "online" : "offline");
  const automationPublisher = data.automationPublisher || data.publisher;
  const automationOperationalStatus = automationPublisher?.operationalStatus || (automationPublisher?.ready ? "online" : "offline");
  const automationPublisherReady = deliverySettings.telegramPublishMode === "bot"
    ? Boolean(automationPublisher?.ready)
    : automationPublisher?.operationalReady ?? Boolean(automationPublisher?.ready);
  const automationPublisherStatus = deliverySettings.telegramPublishMode === "bot"
    ? automationPublisherReady ? "Bot API 发布已启用" : "Bot API 发布未就绪"
    : automationOperationalStatus === "publishing" ? "真人 TG 正在发布"
      : automationOperationalStatus === "stalled" ? "真人发布任务卡住"
        : automationOperationalStatus === "degraded" ? "真人发布桥异常"
          : automationPublisherReady ? "真人 TG 发布桥在线" : "真人 TG 发布桥离线";
  const automationPublisherDetail = automationPublisherReady
    ? `${automaticPublisherName} · ${automationPublisher?.approvedTargetIds?.length || 0} 个白名单目标`
    : deliverySettings.telegramPublishMode === "bot"
      ? "请检查 SpeakerBot Token 与目标群权限"
      : "需保持 Mac、Telegram 与本机发布桥在线";
  const publisherStatus = operationalStatus === "stalled"
    ? "发布任务卡住"
    : operationalStatus === "degraded"
      ? "发布桥异常"
      : operationalStatus === "publishing"
        ? "官方群身份发布中"
        : data.publisher?.ready
          ? publisherIsDesktop ? "本机官方群身份在线" : publisherIsBot ? "Bot API 发布已启用" : "群官方身份已授权"
          : publisherIsDesktop ? "本机发布桥接离线" : publisherIsBot ? "Bot API 发布未就绪" : "群官方发布器未就绪";
  const activeDeliveryDetail = data.publisher?.activeDelivery
    ? ` · 当前投递 ${data.publisher.activeDelivery.id} · 已回写 ${data.publisher.activeDelivery.completedSteps || 0} 步`
    : "";
  const publisherDetail = operationalStatus === "stalled" || operationalStatus === "degraded"
    ? `${data.publisher?.operationalError || data.publisher?.lastError || "发布状态异常"}${activeDeliveryDetail}`
    : data.publisher?.ready
      ? `${publisherName} · ${data.publisher?.approvedTargetIds?.length || 0} 个白名单目标${activeDeliveryDetail}${data.publisher?.lastSeenAt ? ` · 最近心跳 ${new Date(data.publisher.lastSeenAt).toLocaleString("zh-CN", { hour12: false })}` : ""}`
      : publisherIsDesktop ? "需保持 Mac、Telegram 与 Codex 自动发布任务在线" : publisherIsBot ? "生产环境禁止回退到 Bot 发布" : "需完成加密用户会话授权与群 send_as 权限";
  const approvedTargetCount = Array.isArray(data.publisher?.approvedTargetIds)
    ? data.publisher.approvedTargetIds.length
    : 0;
  const analyticsView = view === "site-analytics";

  useEffect(() => {
    setSelectedAutomationRules((current) => reconcileRuleSelection(current, data.rules.filter((rule) => rule.kind === "automation")));
    setSelectedBroadcastRules((current) => reconcileRuleSelection(current, data.rules.filter((rule) => rule.kind === "broadcast")));
  }, [data.rules]);

  return (
    <ConsoleShell>
      <PageHeader
        title={analyticsView ? "网站数据中心" : "内容分发中心"}
        desc={analyticsView ? "在现有后台统一管理代理网站，并观察从访问、视频播放到 Telegram 转化的完整表现。" : `自动发布使用 ${automaticPublisherName}；内容同步使用 ${forwardPublisherName}。两种身份可分别切换并立即应用到生产 Worker。`}
        action={analyticsView ? null : <button className="min-h-11 rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent disabled:opacity-50" disabled={loading || Boolean(busy)} onClick={() => post({ action: "configure-webhook" }, "ForwardBot Webhook 已配置。")}>配置 ForwardBot Webhook</button>}
      />

      {!analyticsView ? <div className="mb-5 rounded-lg border border-[#d9bd73] bg-[#fff9e8] px-4 py-3" role="status">
        <p className="text-sm font-black text-[#5f4513]">发布边界保护已开启</p>
        <p className="mt-1 text-xs leading-5 text-[#7b642f]">{loading ? "正在读取发布白名单与同步边界…" : `自动发布可选择已授权群和 Topic；内容同步只会按已启用规则投递到 ${approvedTargetCount} 个已批准目标。权限或授权异常时停止发送，不会退回错误身份。`}</p>
      </div> : null}

      {!analyticsView ? <div className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <Summary label="数据库" value={loading ? "—" : data.database?.ok ? "正常" : "待配置"} detail={loading ? "正在读取…" : data.database?.driver || "未连接"} />
        <Summary label="内容同步发布器" value={loading ? "—" : publisherStatus} detail={loading ? "正在核验…" : publisherDetail} />
        <Summary label="自动任务" value={loading ? "—" : automationRules.length} detail={loading ? "正在读取…" : `${automationRules.filter((rule) => rule.enabled).length} 条启用`} />
        <Summary label="同步规则" value={loading ? "—" : broadcastRules.length} detail={loading ? "正在读取…" : `${broadcastRules.filter((rule) => rule.enabled).length} 条启用`} />
        <Summary label="代理来源" value={loading ? "—" : socialReadiness.enabled} detail={loading ? "正在读取…" : socialReadiness.ready ? `${socialReadiness.stable} 条稳定可用` : "需要添加 X / YouTube 来源"} />
        <Summary label="待审核" value={loading ? "—" : data.review.length} detail={loading ? "正在读取…" : "默认保留 7 天"} />
      </div> : null}

      {view === "automation" ? loading
        ? <Card className="mb-5 p-5 text-sm font-bold text-ops-muted">正在核验官方群发布闭环…</Card>
        : <OfficialPublishingWorkflow status={automationPublisherStatus} detail={automationPublisherDetail} ready={automationPublisherReady} deliveryMode={deliverySettings.telegramPublishMode} busy={busy} onDeliveryModeChange={(value) => saveDeliveryIdentity("telegramPublishMode", value)} /> : null}

      {!analyticsView && notice ? <div role="status" className="mb-5 rounded-lg border border-ops-line bg-white px-4 py-3 text-sm font-bold text-[#33423b]">{notice}</div> : null}
      {!analyticsView && validation ? <ValidationPanel result={validation} onClose={() => setValidation(null)} /> : null}

      {!loading && view === "automation" && !socialReadiness.ready && automationForm.contentType !== "agent-sync" ? <div className="mb-5 flex flex-col gap-3 rounded-lg border border-[#e7c883] bg-[#fff9e9] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="text-sm font-black text-[#5f4513]">代理的 X / YouTube 更新尚未接入</p><p className="mt-1 text-xs leading-5 text-[#7b642f]">添加并启用代理来源后，系统会每小时抓取、去重并发布到所选群和 Topic。</p></div>
        <button className="min-h-10 shrink-0 rounded-lg bg-[#6f551d] px-4 text-sm font-black text-white" onClick={() => setAutomationForm((current) => ({ ...current, contentType: "agent-sync", schedulePreset: "hourly" }))} type="button">配置代理来源</button>
      </div> : null}

      <div className="mb-5 flex gap-2 overflow-x-auto border-b border-ops-line" role="tablist" aria-label="内容分发功能">
        {tabs.map(([key, label]) => <button aria-selected={view === key} className={`min-h-12 whitespace-nowrap border-b-2 px-4 text-sm font-black ${view === key ? "border-ops-accent text-ops-accent" : "border-transparent text-ops-muted"}`} key={key} onClick={() => changeView(key)} role="tab" type="button">{label}</button>)}
      </div>

      {analyticsView ? <SiteAnalyticsPanel /> : null}
      {loading && !analyticsView ? <Card className="p-8 text-center font-bold text-ops-muted">正在加载持久化配置…</Card> : null}
      {!loading && view === "automation" ? <AutomationView form={automationForm} setForm={setAutomationForm} rules={automationRules} groups={groups} discordState={discordState} socialPackages={socialPackages} publisherName={automaticPublisherName} deliveryMode={deliverySettings.telegramPublishMode} onDeliveryModeChange={(value) => saveDeliveryIdentity("telegramPublishMode", value)} busy={busy} selected={selectedAutomationRules} setSelected={setSelectedAutomationRules} onDeleteMany={(ids) => deleteManyRules(ids, setSelectedAutomationRules, "自动任务")} onSave={() => saveRule(automationForm, () => setAutomationForm(emptyAutomation))} onEdit={setAutomationForm} onAction={post} onValidate={validate} onPersistSocial={saveSocialPackages} onNotice={setNotice} presets={targetPresets} onSavePreset={savePreset} onDeletePreset={deletePreset} /> : null}
      {!loading && view === "destination-cta" ? <DestinationCtaView options={destinationCtaTargetOptions(groups, discordState)} registry={destinationCtas} setRegistry={setDestinationCtas} busy={busy} onSave={saveDestinationCtas} /> : null}
      {!loading && view === "broadcast" ? <BroadcastView form={broadcastForm} setForm={setBroadcastForm} rules={broadcastRules} groups={groups} approvedTargetIds={data.publisher?.approvedTargetIds} publisherName={forwardPublisherName} deliveryMode={deliverySettings.telegramForwardMode} onDeliveryModeChange={(value) => saveDeliveryIdentity("telegramForwardMode", value)} busy={busy} selected={selectedBroadcastRules} setSelected={setSelectedBroadcastRules} onDeleteMany={(ids) => deleteManyRules(ids, setSelectedBroadcastRules, "内容同步规则")} backfill={backfill} setBackfill={setBackfill} onBackfill={previewBackfill} onSave={() => saveRule(broadcastForm, () => setBroadcastForm(emptyBroadcast))} onEdit={setBroadcastForm} onAction={post} onValidate={validate} presets={targetPresets} onSavePreset={savePreset} onDeletePreset={deletePreset} /> : null}
      {!loading && view === "review" ? <ReviewView events={data.review} selected={selectedReviews} setSelected={setSelectedReviews} busy={busy} onAction={reviewAction} /> : null}
      {!loading && view === "logs" ? <LogsView deliveries={data.deliveries} busy={busy} onRetry={async (id) => { setBusy("retry"); try { const response = await fetch("/api/distribution/logs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry", deliveryId: id }) }); const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error); setNotice("失败目标已单独重试，不影响其他目标。"); await loadAll(); } catch (error) { setNotice(error.message); } finally { setBusy(""); } }} /> : null}
    </ConsoleShell>
  );

  function resolveTargets(keys, kind) {
    const options = kind === "automation" ? automationTargetOptions(groups, discordState) : targetOptions(groups);
    return (Array.isArray(keys) ? keys : []).map((key) => options.find((option) => option.key === key)?.target).filter(Boolean);
  }
}

function OfficialPublishingWorkflow({ status, detail, ready, deliveryMode, busy, onDeliveryModeChange }) {
  const steps = deliveryMode === "bot" ? botPublishingSteps : officialPublishingSteps;
  return <Card className="mb-5 p-5">
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <p className="text-base font-black text-ops-ink">官方群身份自动发布工作流</p>
        <p className="mt-1 text-xs leading-5 text-ops-muted">后台生成的图片、正文与 Caption 必须逐字发送，禁止翻译、摘要、改写、增删或重新排版。图片带 Caption 的任务保持为一条 Telegram 消息；Daily Events 保持“独立海报 + 独立正文”。</p>
        <p className="mt-1 text-xs leading-5 text-ops-muted">唯一租约保证单实例发布；图片、Caption 或正文每一步发送后立即回写检查点。中断时后台会保留已完成步骤，不得从头重复发送。</p>
      </div>
      <StatusPill ok={ready}>{status}</StatusPill>
    </div>
    <p className="mt-3 text-xs leading-5 text-ops-muted">{detail}</p>
    <div className="mt-4 rounded-lg border border-ops-line bg-[#fbfcfb] p-4">
      <DeliveryIdentitySelector purpose="顶部自动发布身份" value={deliveryMode} botLabel="使用 SpeakerBot" userLabel="使用真人 TG 账号" botDescription="生产 Worker 通过 Telegram Bot API 自动发布" userDescription="由本机 Telegram Desktop 发布桥发送" busy={busy} onChange={onDeliveryModeChange} />
    </div>
    <ol className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {steps.map((step, index) => <li className="rounded-lg border border-ops-line bg-[#f7faf8] p-3" key={step}><span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-ops-accent text-xs font-black text-white">{index + 1}</span><span className="text-xs font-black text-ops-ink">{step}</span></li>)}
    </ol>
    <div className="mt-4 rounded-lg border border-[#d9bd73] bg-[#fff9e8] p-3">
      <p className="text-xs font-black text-[#5f4513]">自动发布标准路由</p>
      <ul className="mt-2 grid gap-1 text-xs leading-5 text-[#7b642f] md:grid-cols-3">
        {officialPublishingRoutes.map((route) => <li key={route}>{route}</li>)}
      </ul>
    </div>
    <div className="mt-4">
      <p className="text-xs font-black text-ops-ink">Telegram 成品契约</p>
      <p className="mt-1 text-xs leading-5 text-ops-muted">实际发送必须与已定稿 payload 的 imageUrl、caption、text 逐字段一致；任何字段不一致都应停止并记录失败，不能发送近似版本。</p>
      <p className="mt-1 text-xs leading-5 text-[#9a5f31]">多行 Caption / 正文必须通过系统剪贴板一次性粘贴，禁止逐字输入；发送前比对 emoji、标点、空行和服务端 payload，任何差异立即停止并回写失败。</p>
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        {officialPublishingContracts.map((contract) => <div className="rounded-lg border border-ops-line bg-[#f7faf8] p-3" key={contract.name}>
          <p className="text-sm font-black text-ops-ink">{contract.name}</p>
          <p className="mt-1 text-xs font-black text-ops-accent">{contract.output}</p>
          <p className="mt-2 text-xs leading-5 text-ops-muted">{contract.rule}</p>
        </div>)}
      </div>
    </div>
  </Card>;
}

function AutomationView({ form, setForm, rules, groups, discordState, socialPackages, publisherName, deliveryMode, onDeliveryModeChange, busy, selected, setSelected, onDeleteMany, onSave, onEdit, onAction, onValidate, onPersistSocial, onNotice, presets, onSavePreset, onDeletePreset }) {
  const template = getContentTemplate(form.contentType);
  const [confirmedFor, setConfirmedFor] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewState, setPreviewState] = useState("");
  const sourceReadiness = buildSocialSourceReadiness(socialPackages);
  const sourceRouteReadiness = buildSocialSourceRouteReadiness(socialPackages);
  const automationTargets = automationTargetOptions(groups, discordState);
  const enabledSourceRoutes = socialPackages
    .filter((item) => item.status === "已启用")
    .map((item) => ({ id: String(item.id), targets: (Array.isArray(item.targets) ? item.targets : []).map(targetKey).sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const fingerprint = JSON.stringify([form.contentType, form.schedulePreset, [...form.targets].sort(), form.targetCtas || {}, form.contentType === "agent-sync" ? enabledSourceRoutes : []]);
  const confirmed = confirmedFor === fingerprint;
  const sourcesReady = form.contentType !== "agent-sync" || (sourceReadiness.ready && sourceRouteReadiness.ready);
  const canSave = Boolean(form.name.trim() && form.targets.length && sourcesReady && confirmed);

  async function generatePreview() {
    setPreviewState("loading");
    setPreview(null);
    try {
      const response = await fetch("/api/automation-test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: template.jobId }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "内容预览生成失败");
      setPreview(result.result?.preview || null);
      setPreviewState("success");
    } catch (error) {
      setPreviewState(error.message || "内容预览生成失败");
    }
  }

  return <div className="grid gap-5">
    {form.contentType === "agent-sync" ? <SocialSourceManager packages={socialPackages} targetOptions={automationTargets} publisherName={publisherName} busy={busy} onPersist={onPersistSocial} onNotice={onNotice} /> : null}
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(340px,.92fr)]">
    <RuleForm title={form.id ? "编辑自动任务" : "新增自动任务"} eyebrow="按发送前确认流程配置" submitLabel="保存自动任务" submitDisabled={!canSave} submitHint={!form.name.trim() ? "请先填写任务名称" : !form.targets.length ? "请至少选择一个 Telegram Topic 或 Discord Channel" : form.contentType === "agent-sync" && !sourceReadiness.ready ? "请先添加并启用至少一条代理来源" : form.contentType === "agent-sync" && !sourceRouteReadiness.ready ? `请为 ${sourceRouteReadiness.unmappedIds.length} 条已启用来源绑定发送群和 Topic` : !confirmed ? "请确认内容模板、频率和目标" : "已完成发送前确认"} busy={busy} onSubmit={onSave}>
      <DeliveryIdentitySelector purpose="自动发布身份" value={deliveryMode} botLabel="使用 SpeakerBot" userLabel="使用真人 TG 账号" botDescription="服务器通过 Telegram Bot API 自动发布" userDescription="由本机 Telegram Desktop 发布桥发送" busy={busy} onChange={onDeliveryModeChange} />
      <FormStep number="1" title="选择内容模板" desc="模板决定 Telegram 文案结构、配图和数据来源。" />
      <Field label="任务名称"><input className={inputClass} required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：每日市场事件" /></Field>
      <Field label="内容模板"><select className={inputClass} value={form.contentType} onChange={(event) => { const contentType = event.target.value; setForm({ ...form, contentType, schedulePreset: recommendedScheduleFor(contentType) }); setPreview(null); setPreviewState(""); }}>{contentTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <div className="rounded-lg border border-[#cae5da] bg-[#f2faf6] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm text-[#173f31]">{template.format}</strong><span className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-ops-accent">推荐：{labelFor(schedules, template.recommendedSchedule)}</span></div>
        <p className="mt-2 text-sm leading-6 text-[#41564d]">{template.description}</p>
      </div>
      <FormStep number="2" title="确认频率" desc="日更任务按 UTC 运行；监控任务按时间窗口扫描并去重。" />
      <Field label="预设频率"><select className={inputClass} value={form.schedulePreset} disabled={form.contentType === "whale-signals"} onChange={(event) => setForm({ ...form, schedulePreset: event.target.value })}>{schedules.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{form.contentType === "whale-signals" ? <p className="mt-1 text-xs text-ops-muted">系统每小时检查真实订单簿，仅在异动达到阈值时发布，相同信号冷却期内不重复。</p> : null}</Field>
      <FormStep number="3" title="选择发布目标" desc={form.contentType === "agent-sync" ? "每条来源优先使用上方独立绑定；此处任务目标用于兼容旧配置和异常兜底。" : `建议发布到 ${template.destinationHint}；可选择一个或多个已授权的群和 Topic。`} />
      <TargetPicker options={automationTargets} selected={form.targets} onChange={(targets) => setForm({ ...form, targets, targetCtas: retainTargetCtas(form.targetCtas, targets) })} presets={presets} onSavePreset={(name) => onSavePreset(name, form.targets)} onDeletePreset={onDeletePreset} />
      <p className="rounded-lg border border-[#cae5da] bg-[#f2faf6] p-3 text-xs leading-5 text-[#41564d]">所选目标的 CTA 由「频道 CTA」统一维护，任务执行到每个频道或 Topic 前会自动读取。</p>
      <Toggle checked={form.enabled} label="创建后立即启用" onChange={(enabled) => setForm({ ...form, enabled })} />
      <label className="flex items-start gap-3 rounded-lg border border-ops-line bg-[#fbfcfb] p-3 text-sm font-bold leading-6 text-[#33423b]"><input className="mt-1" checked={confirmed} onChange={(event) => setConfirmedFor(event.target.checked ? fingerprint : "")} type="checkbox" /><span>我已确认发送模板、频率和目标。动态数据会在实际执行时刷新。</span></label>
    </RuleForm>
    <TelegramTemplatePreview form={form} template={template} publisherName={publisherName} preview={preview} previewState={previewState} onGenerate={generatePreview} />
    </div>
    <RuleList busy={busy} empty="暂无自动任务。" kindLabel="自动任务" rules={rules} selected={selected} setSelected={setSelected} onDeleteMany={onDeleteMany} onEdit={(rule) => onEdit({ ...rule, targets: rule.targets.map(targetKey), targetCtas: targetCtasFromTargets(rule.targets) })} onAction={onAction} onValidate={onValidate} />
  </div>;
}

function BroadcastView({ form, setForm, rules, groups, approvedTargetIds, publisherName, deliveryMode, onDeliveryModeChange, busy, selected, setSelected, onDeleteMany, backfill, setBackfill, onBackfill, onSave, onEdit, onAction, onValidate, presets, onSavePreset, onDeletePreset }) {
  const sources = sourceOptions(groups);
  const sourceValue = sourceKey(form.source);
  const approvedIds = new Set((Array.isArray(approvedTargetIds) ? approvedTargetIds : []).map(String));
  const approvedTargets = targetOptions(groups)
    .filter((option) => approvedIds.has(String(option.target.chatId)));
  const broadcastTargets = filterBroadcastTargetOptions(approvedTargets, form.source);
  const resolvedTargets = form.targets.map((key) => broadcastTargets.find((option) => option.key === key)?.target).filter(Boolean);
  const route = buildBroadcastRouteSummary({ source: form.source, mode: form.mode, targets: resolvedTargets });
  const canSave = Boolean(form.name.trim() && route.ready);
  function setBroadcastSource(source) {
    const allowedKeys = new Set(filterBroadcastTargetOptions(approvedTargets, source).map((option) => option.key));
    setForm({
      ...form,
      source,
      targets: form.targets.filter((key) => allowedKeys.has(key))
    });
  }
  return <div className="grid gap-5">
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(340px,.92fr)]">
      <RuleForm title={form.id ? "编辑内容同步规则" : "新增内容同步规则"} eyebrow={`ForwardBot 监听 · ${publisherName} 发布`} submitLabel="保存内容同步规则" submitDisabled={!canSave} submitHint={!form.name.trim() ? "请先填写规则名称" : route.missing.length ? `还需要：${route.missing.join("、")}` : "同步路径已完整"} busy={busy} onSubmit={onSave}>
        <div className="rounded-lg border border-[#cae5da] bg-[#f2faf6] p-4"><p className="text-sm font-black text-[#173f31]">从哪里同步到哪里</p><p className="mt-1 text-xs leading-5 text-[#41564d]">ForwardBot 监听指定来源群、频道或 Topic；通过审核或自动处理后，由当前选择的 {publisherName} 发布。</p></div>
        <DeliveryIdentitySelector purpose="转发发布身份" value={deliveryMode} botLabel="使用 ForwardBot" userLabel="使用真人 TG 账号" botDescription="ForwardBot 通过 Bot API 复制到目标 Topic" userDescription="由本机 Telegram Desktop 发布桥发送" busy={busy} onChange={onDeliveryModeChange} />
        <Field label="规则名称"><input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：Demo 群同步到新群" /></Field>
        <FormStep number="1" title="选择消息来源" desc="Forum 群必须选择具体来源 Topic；Channel 选择整个频道。" />
        <Field label="来源群 / 频道 / Topic"><select className={inputClass} value={sourceValue} onChange={(event) => setBroadcastSource(sources.find((item) => item.key === event.target.value)?.source || emptyBroadcast.source)}><option value="">请选择来源</option>{sources.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></Field>
        <details className="rounded-lg border border-ops-line bg-[#fbfcfb] p-3"><summary className="cursor-pointer text-sm font-black text-[#41564d]">高级：手动输入 Telegram ID</summary><div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px_140px]"><Field label="来源 Chat ID"><input className={inputClass} value={form.source.chatId} onChange={(event) => setForm({ ...form, source: { ...form.source, chatId: event.target.value } })} /></Field><Field label="Chat 类型"><select className={inputClass} value={form.source.chatType || "supergroup"} onChange={(event) => { const chatType = event.target.value; setForm({ ...form, source: { ...form.source, chatType, threadId: chatType === "channel" ? "" : form.source.threadId } }); }}><option value="supergroup">群 / Topic</option><option value="channel">Channel</option></select></Field><Field label="Thread ID（群必填）"><input className={inputClass} disabled={form.source.chatType === "channel"} inputMode="numeric" value={form.source.threadId || ""} onChange={(event) => setForm({ ...form, source: { ...form.source, threadId: event.target.value } })} /></Field></div><p className="mt-2 text-xs text-ops-muted">Channel 不使用 Thread ID；Forum 群必须填写 Thread ID，确保只同步指定 Topic。</p></details>
        <FormStep number="2" title="选择处理方式" desc="运营敏感内容建议先审核，日常同步可直接自动转发。" />
        <fieldset className="grid gap-2 sm:grid-cols-2"><legend className="sr-only">处理方式</legend>{[["automatic", "自动转发", "新消息通常 10 秒内到达目标"], ["review", "先审核", "批准前绝不发送，默认保留 7 天"]].map(([value, title, desc]) => <label className={`rounded-lg border p-4 ${form.mode === value ? "border-ops-accent bg-[#f2faf6]" : "border-ops-line bg-white"}`} key={value}><span className="flex items-center gap-2 text-sm font-black"><input checked={form.mode === value} name="broadcast-mode" onChange={() => setForm({ ...form, mode: value })} type="radio" />{title}</span><span className="mt-2 block text-xs leading-5 text-ops-muted">{desc}</span></label>)}</fieldset>
        <FormStep number="3" title="选择同步目标" desc="一条来源可以同步到其他已授权群的多个 Topic；来源群不会出现在目标列表，避免群内回环。" />
        <TargetPicker options={broadcastTargets} selected={form.targets.filter((key) => broadcastTargets.some((option) => option.key === key))} onChange={(targets) => setForm({ ...form, targets })} presets={presets} onSavePreset={(name) => onSavePreset(name, form.targets)} onDeletePreset={onDeletePreset} />
        <Toggle checked={form.enabled} label="创建后立即启用" onChange={(enabled) => setForm({ ...form, enabled })} />
        <div className="rounded-lg bg-[#fff8e8] p-3 text-xs leading-5 text-[#79591e]">ForwardBot 固定负责监听和接收入站消息；当前选择由 {publisherName} 向目标发布。切换为 ForwardBot 时使用 Bot API；切换为真人 TG 时进入本机发布桥。Bot API 无法感知来源消息删除；可处理的文字与 Caption 编辑会同步。</div>
      </RuleForm>
      <BroadcastRoutePreview route={route} targets={resolvedTargets} mode={form.mode} publisherName={publisherName} />
    </div>
    <div className="grid items-start gap-5 xl:grid-cols-2"><BackfillPanel rules={rules} value={backfill} setValue={setBackfill} busy={busy} onRun={onBackfill} /><RuleList busy={busy} empty="暂无内容同步规则。" kindLabel="内容同步规则" rules={rules} selected={selected} setSelected={setSelected} onDeleteMany={onDeleteMany} onEdit={(rule) => onEdit({ ...rule, source: { ...rule.source, threadId: rule.source.threadId || "" }, targets: rule.targets.map(targetKey) })} onAction={onAction} onValidate={onValidate} /></div>
  </div>;
}

function RuleForm({ title, eyebrow, submitLabel, submitDisabled = false, submitHint, busy, onSubmit, children }) {
  return <Card className="overflow-hidden"><div className="border-b border-ops-line p-5">{eyebrow ? <p className="mb-1 text-xs font-black uppercase tracking-[.16em] text-ops-accent">{eyebrow}</p> : null}<h2 className="text-xl font-black">{title}</h2></div><form className="grid gap-4 p-5" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>{children}<div><button className="min-h-11 w-full rounded-lg bg-ops-accent px-5 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-[#9fb5ac]" disabled={Boolean(busy) || submitDisabled} type="submit">{busy ? "处理中…" : submitLabel}</button>{submitHint ? <p className="mt-2 text-center text-xs font-bold text-ops-muted">{submitHint}</p> : null}</div></form></Card>;
}

function FormStep({ number, title, desc }) {
  return <div className="mt-1 flex gap-3 border-t border-ops-line pt-4 first:mt-0 first:border-t-0 first:pt-0"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#e6f7ef] text-xs font-black text-ops-accent">{number}</span><div><h3 className="text-sm font-black text-[#21352d]">{title}</h3><p className="mt-1 text-xs leading-5 text-ops-muted">{desc}</p></div></div>;
}

function DeliveryIdentitySelector({ purpose, value, botLabel, userLabel, botDescription, userDescription, busy, onChange }) {
  return <fieldset className="grid gap-2"><legend className="mb-1 text-sm font-black text-[#21352d]">{purpose}</legend><div className="grid gap-2 sm:grid-cols-2">{[["bot", botLabel, botDescription], ["user", userLabel, userDescription]].map(([mode, label, description]) => <label className={`rounded-lg border p-4 ${value === mode ? "border-ops-accent bg-[#f2faf6]" : "border-ops-line bg-white"}`} key={mode}><span className="flex items-center gap-2 text-sm font-black"><input checked={value === mode} disabled={Boolean(busy)} name={purpose} onChange={() => onChange(mode)} type="radio" />{label}</span><span className="mt-2 block text-xs leading-5 text-ops-muted">{description}</span></label>)}</div></fieldset>;
}

function TelegramTemplatePreview({ form, template, publisherName, preview, previewState, onGenerate }) {
  const templatePreview = template.preview || null;
  const displayPreview = preview || templatePreview;
  const caption = displayPreview?.caption ? stripTelegramHtml(displayPreview.caption) : "当前模板还没有样稿，请生成一次真实内容预览。";
  const isLivePreview = Boolean(preview);
  return <Card className="overflow-hidden xl:sticky xl:top-5">
    <div className="border-b border-ops-line p-5"><p className="text-xs font-black uppercase tracking-[.16em] text-ops-accent">发送前预览</p><div className="mt-1 flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-black">Telegram 成品</h2><StatusPill tone={isLivePreview ? "green" : "amber"}>{isLivePreview ? "实时数据预览" : templatePreview ? "英文模板样稿" : "待生成"}</StatusPill></div></div>
    <div className="bg-[#e8f0ec] p-4 sm:p-5">
      <div className="mx-auto max-w-[520px] rounded-xl rounded-tl-sm bg-white p-3 shadow-sm">
        <div className="flex items-center justify-between gap-3"><strong className="text-sm text-ops-accent">目标群官方身份</strong><span className="text-[11px] text-ops-muted">{template.format}</span></div>
        {displayPreview?.imageUrl ? <img alt={`${template.label} Telegram 配图预览`} className="mt-3 aspect-video w-full rounded-lg object-cover" src={displayPreview.imageUrl} /> : null}
        <p className="mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-[#24362f]">{caption}</p>
        <div className="mt-3 border-t border-[#edf1ef] pt-2 text-[11px] leading-5 text-ops-muted">{template.runtimeNote}</div>
      </div>
      {displayPreview?.items?.length ? <div className="mx-auto mt-2 max-w-[520px] rounded-xl rounded-tl-sm bg-white p-3 shadow-sm">
        <div className="flex items-center justify-between gap-3"><strong className="text-sm text-ops-accent">目标群官方身份</strong><span className="text-[11px] text-ops-muted">English brief · 2/2</span></div>
        <ol className="mt-3 max-h-80 list-decimal space-y-3 overflow-y-auto pl-5 text-sm leading-6 text-[#24362f]">{displayPreview.items.map((item, index) => <li key={`${index}-${String(item).slice(0, 24)}`}>{typeof item === "string" ? item : item.title || item.name || JSON.stringify(item)}</li>)}</ol>
        <p className="mt-3 border-t border-[#edf1ef] pt-2 text-[11px] leading-5 text-[#9a5f31]">{displayPreview.disclaimer || templatePreview?.disclaimer}</p>
      </div> : null}
    </div>
    <div className="grid gap-3 p-5">
      {templatePreview?.sections?.length ? <div><p className="mb-2 text-xs font-black text-ops-muted">模板内容结构</p><div className="flex flex-wrap gap-2">{templatePreview.sections.map((section) => <span className="rounded-full bg-[#edf6f1] px-2.5 py-1 text-xs font-bold text-[#2d5a48]" key={section}>{section}</span>)}</div></div> : null}
      <div className="grid gap-2 text-sm sm:grid-cols-2"><PreviewFact label="发送频率" value={labelFor(schedules, form.schedulePreset)} /><PreviewFact label="目标数量" value={`${form.targets.length} 个目标`} />{template.itemCountPolicy ? <PreviewFact label="内容条数" value={template.itemCountPolicy} /> : <PreviewFact label="建议位置" value={template.destinationHint} />}<PreviewFact label="发布身份" value={`目标群名称和头像（由 ${publisherName} 匿名授权）`} /></div>
      {previewState && previewState !== "success" && previewState !== "loading" ? <p role="alert" className="rounded-lg bg-[#fff2ef] p-3 text-xs font-bold text-[#a04a3d]">{previewState}</p> : null}
      <button className="min-h-11 rounded-lg border border-ops-accent px-4 text-sm font-black text-ops-accent disabled:opacity-50" disabled={previewState === "loading" || !template.jobId} onClick={onGenerate} type="button">{previewState === "loading" ? "正在生成实时数据…" : preview ? "刷新实时数据预览" : "切换为本次实时数据预览"}</button>
      <p className="text-center text-xs leading-5 text-ops-muted">此操作只运行数据与模板，不会向 Telegram 发送消息。</p>
    </div>
  </Card>;
}

function BroadcastRoutePreview({ route, targets, mode, publisherName }) {
  return <Card className="overflow-hidden xl:sticky xl:top-5">
    <div className="border-b border-ops-line p-5"><p className="text-xs font-black uppercase tracking-[.16em] text-ops-accent">同步路径预览</p><div className="mt-1 flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-black">从哪里同步到哪里</h2><StatusPill tone={route.ready ? "green" : "amber"}>{route.ready ? "路径完整" : "尚未完成"}</StatusPill></div></div>
    <div className="grid gap-3 p-5">
      <RouteNode label="消息来源" value={route.sourceLabel} />
      <div className="border-l-2 border-dashed border-[#b7c9c0] py-2 pl-5 text-xs font-black text-ops-muted">ForwardBot 监听并接收新消息</div>
      <RouteNode label={mode === "review" ? "待审核队列" : "自动处理"} value={route.processingLabel} accent />
      <div className="border-l-2 border-dashed border-[#b7c9c0] py-2 pl-5 text-xs font-black text-ops-muted">{publisherName} 匿名授权，以各目标群官方身份独立发送与记录</div>
      <div className="rounded-lg border border-ops-line p-4"><div className="flex items-center justify-between"><span className="text-xs font-black uppercase tracking-wide text-ops-muted">同步目标</span><span className="text-sm font-black text-ops-accent">{route.targetCount} 个</span></div>{targets.length ? <ul className="mt-3 grid gap-2">{targets.map((target) => <li className="rounded-md bg-[#f6f9f7] px-3 py-2 text-sm font-bold text-[#33423b]" key={targetKey(target)}>{target.groupName || target.chatId} / {destinationLabel(target)}</li>)}</ul> : <p className="mt-3 text-sm text-ops-muted">选择目标后会在这里显示完整路径。</p>}</div>
      {!route.ready ? <p className="rounded-lg bg-[#fff8e8] p-3 text-xs font-bold leading-5 text-[#79591e]">保存前还需要：{route.missing.join("、")}。</p> : null}
      <div className="grid gap-2 border-t border-ops-line pt-4 text-xs leading-5 text-ops-muted"><p>支持文字、图片、视频、文件、链接、媒体组和可处理的 Caption 编辑。</p><p>源消息删除无法由 Telegram Bot API 感知，不会自动删除目标消息。</p></div>
    </div>
  </Card>;
}

function RouteNode({ label, value, accent = false }) {
  return <div className={`rounded-lg border p-4 ${accent ? "border-[#a9d9c5] bg-[#f2faf6]" : "border-ops-line bg-white"}`}><div className="text-xs font-black uppercase tracking-wide text-ops-muted">{label}</div><div className="mt-1 break-words text-sm font-black text-[#24362f]">{value}</div></div>;
}

function PreviewFact({ label, value }) {
  return <div className="rounded-lg bg-[#f6f9f7] p-3"><div className="text-[11px] font-bold text-ops-muted">{label}</div><div className="mt-1 font-black text-[#24362f]">{value}</div></div>;
}

function RuleList({ rules, empty, busy, kindLabel, selected, setSelected, onDeleteMany, onEdit, onAction, onValidate }) {
  const selectAllRef = useRef(null);
  const ruleIds = rules.map((rule) => String(rule.id));
  const visibleSelected = reconcileRuleSelection(selected, rules);
  const selectedCount = visibleSelected.length;
  const allSelected = Boolean(ruleIds.length) && selectedCount === ruleIds.length;
  const partiallySelected = selectedCount > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = partiallySelected;
  }, [partiallySelected]);

  function toggleRule(id) {
    const key = String(id);
    setSelected(visibleSelected.includes(key) ? visibleSelected.filter((selectedId) => selectedId !== key) : [...visibleSelected, key]);
  }

  return <Card className="overflow-hidden">
    <div className="flex flex-col gap-4 border-b border-ops-line p-5 lg:flex-row lg:items-center lg:justify-between">
      <div><h2 className="text-xl font-black">现有规则</h2><p className="mt-1 text-sm text-ops-muted">Telegram 使用 Chat ID + Thread ID；Discord 使用 Guild ID + Channel ID，改名不会让规则失效。</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-9 items-center gap-2 rounded-lg border border-ops-line px-3 text-xs font-black text-[#33423b]">
          <input aria-label="选择当前列表全部规则" checked={allSelected} disabled={!rules.length || Boolean(busy)} onChange={(event) => setSelected(event.target.checked ? ruleIds : [])} ref={selectAllRef} type="checkbox" />
          全选当前列表
        </label>
        <SmallButton disabled={!selectedCount || Boolean(busy)} onClick={() => setSelected([])}>清空选择</SmallButton>
        <SmallButton danger disabled={!selectedCount || Boolean(busy)} onClick={() => onDeleteMany(visibleSelected)}>删除已选（{selectedCount}）</SmallButton>
      </div>
    </div>
    <div className="divide-y divide-ops-line">{rules.length ? rules.map((rule) => {
      const ruleId = String(rule.id);
      return <article className="flex items-start gap-3 p-5" key={rule.id}>
        <input aria-label={`选择规则：${rule.name}`} checked={visibleSelected.includes(ruleId)} className="mt-1" disabled={Boolean(busy)} onChange={() => toggleRule(ruleId)} type="checkbox" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><h3 className="font-black">{rule.name}</h3><StatusPill tone={rule.enabled ? "green" : "amber"}>{rule.runOnce ? rule.status === "completed" ? "已执行" : rule.status === "failed" ? "执行失败" : rule.status === "running" ? "执行中" : "等待执行" : rule.enabled ? "已启用" : "已暂停"}</StatusPill>{rule.runOnce ? <StatusPill tone="amber">一次性</StatusPill> : null}{rule.status === "pending-confirmation" ? <StatusPill tone="amber">待确认</StatusPill> : null}</div>
              <p className="mt-2 text-sm text-ops-muted">{rule.kind === "automation" ? rule.runOnce ? `${labelFor(contentTypes, rule.contentType)} · 一次性执行 · ${rule.status === "completed" ? "已完成" : rule.status === "failed" ? "失败（可在运行记录中查看原因）" : rule.status === "running" ? "正在执行" : formatTime(rule.nextRunAt)}` : `${labelFor(contentTypes, rule.contentType)} · ${labelFor(schedules, rule.schedulePreset)} · 下次 ${formatTime(rule.nextRunAt)}` : `${rule.mode === "review" ? "审核模式" : "自动模式"} · 来源 ${rule.source?.chatId}:${destinationLabel(rule.source)}`}</p>
              <p className="mt-1 text-xs text-ops-muted">{rule.targets.length} 个目标 · {rule.targets.map((target) => `${target.groupName || target.guildId || target.chatId}/${destinationLabel(target)}`).join("、")}</p>
              {rule.kind === "automation" && targetCtaCount(rule.targets) ? <p className="mt-1 text-xs font-bold text-[#317a58]">{targetCtaCount(rule.targets)} 个目标已配置 CTA</p> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {rule.runOnce ? null : <SmallButton disabled={Boolean(busy)} onClick={() => onEdit(rule)}>编辑</SmallButton>}
              <SmallButton disabled={Boolean(busy)} onClick={() => onValidate(rule.id)}>验证配置</SmallButton>
              {rule.kind === "automation" ? rule.runOnce ? null : <SmallButton disabled={Boolean(busy)} onClick={() => window.confirm("将按当前模板立即向全部目标发送真实内容，确认继续？") && onAction({ action: "run-now", id: rule.id }, "真实内容已发布，结果已写入运行记录。")}>立即发布</SmallButton> : <SmallButton disabled={Boolean(busy)} onClick={() => onAction({ action: "test", id: rule.id }, "测试消息已按目标分别发送。")}>发送测试</SmallButton>}
              {rule.runOnce ? null : <SmallButton disabled={Boolean(busy)} onClick={() => onAction({ action: "toggle", id: rule.id, enabled: !rule.enabled }, rule.enabled ? "规则已暂停。" : "规则已启用。")}>{rule.enabled ? "暂停" : "启用"}</SmallButton>}
              <SmallButton danger disabled={Boolean(busy)} onClick={() => window.confirm(`确认删除这条${kindLabel}？`) && onAction({ action: "delete", id: rule.id }, "规则已删除。")}>删除</SmallButton>
            </div>
          </div>
        </div>
      </article>;
    }) : <div className="p-8 text-center font-bold text-ops-muted">{empty}</div>}</div>
  </Card>;
}

function TargetPicker({ options, selected, onChange, presets = [], onSavePreset, onDeletePreset }) {
  const [presetName, setPresetName] = useState("");
  const optionGroups = groupDistributionTargetOptions(options);
  return <fieldset className="grid gap-2"><legend className="mb-1 text-sm font-bold text-ops-muted">发布目标（Telegram Topic / Discord Channel，可多选）</legend>
    {presets.length > 0 ? (
       <div className="mb-2 flex flex-wrap gap-2">
         {presets.map(p => (
           <div key={p.id} className="flex items-center gap-1 rounded bg-[#e8f0ec] px-2 py-1 text-xs text-[#173f31]">
             <button type="button" onClick={() => onChange(p.targets)} className="font-bold hover:underline">{p.name}</button>
             <button type="button" onClick={() => onDeletePreset && window.confirm(`确认删除预设 "${p.name}"？`) && onDeletePreset(p.id)} className="ml-1 text-[#8b9d94] hover:text-[#d85f5f]">×</button>
           </div>
         ))}
       </div>
    ) : null}
    <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg border border-ops-line p-2">{optionGroups.length ? optionGroups.map((group) => {
      const selectedCount = group.options.filter((option) => selected.includes(option.key)).length;
      return <details className="overflow-hidden rounded-lg border border-ops-line bg-white" key={group.key}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 text-sm font-black hover:bg-ops-soft">
          <span className="flex min-w-0 items-center gap-2"><StatusPill tone={group.platform === "discord" ? "amber" : "green"}>{group.platform === "discord" ? "Discord" : "Telegram"}</StatusPill><span className="truncate">{group.label}</span></span>
          <span className="shrink-0 text-xs font-bold text-ops-muted">{selectedCount}/{group.options.length}</span>
        </summary>
        <div className="border-t border-ops-line p-1">{group.options.map((option) => <label className="flex min-h-10 items-center gap-3 rounded-md px-2 text-sm hover:bg-ops-soft" key={option.key}><input checked={selected.includes(option.key)} onChange={() => onChange(selected.includes(option.key) ? selected.filter((key) => key !== option.key) : [...selected, option.key])} type="checkbox" /><span>{destinationLabel(option.target)}</span></label>)}</div>
      </details>;
    }) : <p className="p-2 text-sm text-ops-muted">暂未识别到可发布的 Telegram Topic 或 Discord Channel，请先刷新社区配置。</p>}</div>
    {onSavePreset ? (
      <div className="mt-2 flex gap-2">
        <input className={inputClass + " flex-1"} placeholder="预设名称..." value={presetName} onChange={e => setPresetName(e.target.value)} />
        <SmallButton disabled={!presetName || !selected.length} onClick={() => { onSavePreset(presetName); setPresetName(""); }}>保存当前选择为预设</SmallButton>
      </div>
    ) : null}
  </fieldset>;
}

function DestinationCtaView({ options, registry, setRegistry, busy, onSave }) {
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredOptions = options.filter((option) => {
    const target = option.target || {};
    const haystack = [option.groupLabel, target.groupName, target.guildName, target.topicName, target.channelName, target.chatId, target.channelId].join(" ").toLocaleLowerCase();
    return !normalizedSearch || haystack.includes(normalizedSearch);
  });
  const optionGroups = groupDistributionTargetOptions(filteredOptions);

  function configFor(target) {
    return registry[destinationCtaConfigKey(target)] || {
      ...target,
      ctaEnabled: false,
      ctaText: "",
      ctaUrl: ""
    };
  }

  function update(target, patch) {
    const key = destinationCtaConfigKey(target);
    const current = configFor(target);
    setRegistry({ ...registry, [key]: { ...current, ...target, ...patch } });
  }

  return <div className="grid gap-5">
    <Card className="p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-xl font-black">频道与 Topic CTA 配置</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ops-muted">CTA 与固定目标绑定。Telegram 按群组 + Topic，Discord 按 Channel 保存；内容分发到每个目标时会在发送前自动读取，并分别追加到消息末尾。</p>
        </div>
        <button className="min-h-11 rounded-lg bg-ops-accent px-5 text-sm font-black text-white disabled:opacity-50" disabled={Boolean(busy)} onClick={() => onSave(Object.values(registry))} type="button">{busy === "destination-cta" ? "保存中…" : "保存全部配置"}</button>
      </div>
      <div className="mt-5"><Field label="搜索频道或 Topic"><input className={inputClass} onChange={(event) => setSearch(event.target.value)} placeholder="输入群组、Server、Topic 或 Channel 名称" type="search" value={search} /></Field></div>
    </Card>

    {optionGroups.length ? optionGroups.map((group) => <Card className="overflow-hidden" key={group.key}>
      <div className="flex items-center justify-between border-b border-ops-line p-4"><div className="flex items-center gap-2"><StatusPill tone={group.platform === "discord" ? "amber" : "green"}>{group.platform === "discord" ? "Discord" : "Telegram"}</StatusPill><h3 className="font-black">{group.label}</h3></div><span className="text-xs font-bold text-ops-muted">{group.options.length} 个目标</span></div>
      <div className="divide-y divide-ops-line">{group.options.map((option) => {
        const target = option.target;
        const cta = configFor(target);
        return <div className="grid gap-3 p-4 lg:grid-cols-[minmax(180px,.8fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end" key={destinationCtaConfigKey(target)}>
          <div><p className="text-xs font-bold text-ops-muted">目标</p><p className="mt-2 text-sm font-black">{destinationLabel(target)}</p></div>
          <Field label="CTA 文案"><input className={inputClass} onChange={(event) => update(target, { ctaText: event.target.value, ctaEnabled: true })} placeholder="例如：立即加入 YUBIT" value={cta.ctaText || ""} /></Field>
          <Field label="CTA 链接"><input className={inputClass} onChange={(event) => update(target, { ctaUrl: event.target.value, ctaEnabled: true })} placeholder="https://…" type="url" value={cta.ctaUrl || ""} /></Field>
          <Toggle checked={cta.ctaEnabled === true} label="启用 CTA" onChange={(ctaEnabled) => update(target, { ctaEnabled })} />
        </div>;
      })}</div>
    </Card>) : <Card className="p-8 text-center text-sm font-bold text-ops-muted">没有匹配的 Telegram Topic 或 Discord Channel。</Card>}
  </div>;
}

function groupDistributionTargetOptions(options = []) {
  const groups = new Map();
  for (const option of options) {
    const platform = option.target?.platform === "discord" ? "discord" : "telegram";
    const destinationId = platform === "discord" ? option.target?.guildId : option.target?.chatId;
    const key = `${platform}:${destinationId || "unknown"}`;
    if (!groups.has(key)) groups.set(key, { key, platform, label: option.groupLabel || option.target?.groupName || destinationId || "未命名群组", options: [] });
    groups.get(key).options.push(option);
  }
  return [...groups.values()];
}

function BackfillPanel({ rules, value, setValue, busy, onRun }) {
  return <Card className="p-5"><h2 className="text-lg font-black">人工回填历史消息</h2><p className="mt-1 text-sm leading-6 text-ops-muted">输入 Telegram 消息链接、编号或范围，单次最多 100 条。未被 Webhook 捕获过的历史正文无法由 Bot API 预读，但可先核对编号与目标再复制。</p><div className="mt-4 grid gap-3"><Field label="内容同步规则"><select className={inputClass} value={value.ruleId} onChange={(event) => setValue({ ...value, ruleId: event.target.value, preview: null })}><option value="">请选择规则</option>{rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</select></Field><Field label="消息链接 / 编号"><textarea className={`${inputClass} min-h-24 py-3`} value={value.references} onChange={(event) => setValue({ ...value, references: event.target.value, preview: null })} placeholder="77, 79-81 或 https://t.me/c/.../90" /></Field><div className="flex gap-2"><SmallButton disabled={Boolean(busy)} onClick={() => onRun(false)}>预览</SmallButton><button className="min-h-10 rounded-lg bg-ops-accent px-4 text-sm font-black text-white disabled:opacity-50" disabled={!value.preview?.preview || Boolean(busy)} onClick={() => window.confirm("确认向所有目标补发这些历史消息？") && onRun(true)} type="button">确认补发</button></div>{value.preview ? <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-[#f5f7f6] p-3 text-xs">{JSON.stringify(value.preview, null, 2)}</pre> : null}</div></Card>;
}

function ReviewView({ events, selected, setSelected, busy, onAction }) {
  return <Card className="overflow-hidden"><div className="flex flex-col gap-3 border-b border-ops-line p-5 md:flex-row md:items-center md:justify-between"><div><h2 className="text-xl font-black">待审核队列</h2><p className="mt-1 text-sm text-ops-muted">未批准前绝不发送；拒绝或过期后不能再次发布。</p></div><div className="flex gap-2"><SmallButton disabled={!selected.length || Boolean(busy)} onClick={() => onAction("approve", selected)}>批量批准</SmallButton><SmallButton danger disabled={!selected.length || Boolean(busy)} onClick={() => onAction("reject", selected)}>批量拒绝</SmallButton></div></div><div className="divide-y divide-ops-line">{events.length ? events.map((event) => <article className="flex gap-3 p-5" key={event.id}><input aria-label="选择审核消息" checked={selected.includes(event.id)} onChange={() => setSelected(selected.includes(event.id) ? selected.filter((id) => id !== event.id) : [...selected, event.id])} type="checkbox" /><div className="min-w-0 flex-1"><div className="text-sm font-black">来源 {event.sourceChatId} · 消息 {event.sourceMessageId}</div><div className="mt-2 flex flex-wrap gap-2"><StatusPill tone="amber">{messageType(event.payload, event.mediaGroupId)}</StatusPill>{event.mediaGroupId ? <StatusPill tone="amber">媒体组</StatusPill> : null}</div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[#33423b]">{event.payload?.text || event.payload?.caption || "此消息没有文字说明，批准后将原样复制媒体或文件。"}</p><p className="mt-2 text-xs text-ops-muted">过期时间：{formatTime(event.expiresAt)}</p><div className="mt-3 flex gap-2"><SmallButton onClick={() => onAction("approve", [event.id])}>批准</SmallButton><SmallButton danger onClick={() => onAction("reject", [event.id])}>拒绝</SmallButton></div></div></article>) : <div className="p-8 text-center font-bold text-ops-muted">当前没有待审核内容。</div>}</div></Card>;
}

function LogsView({ deliveries, busy, onRetry }) {
  return <Card className="overflow-hidden"><div className="border-b border-ops-line p-5"><h2 className="text-xl font-black">逐目标运行记录</h2><p className="mt-1 text-sm leading-6 text-ops-muted">默认保留 30 天；单个目标失败不会影响其他目标，可精确重试。官方群发布会逐步回写检查点，中断后从未完成步骤继续。</p></div><div className="overflow-x-auto"><table className="w-full min-w-[940px] text-left text-sm"><thead className="bg-[#f9fbfa] text-xs uppercase text-ops-muted"><tr><th className="px-5 py-3">时间</th><th className="px-5 py-3">规则 / 目标</th><th className="px-5 py-3">状态</th><th className="px-5 py-3">重试</th><th className="px-5 py-3">发布检查点</th><th className="px-5 py-3">平台消息</th><th className="px-5 py-3">错误</th><th className="px-5 py-3">操作</th></tr></thead><tbody>{deliveries.length ? deliveries.map((row) => <tr className="border-t border-ops-line align-top" key={row.id}><td className="px-5 py-4 text-xs">{formatTime(row.createdAt)}</td><td className="px-5 py-4"><div className="font-mono text-xs">{row.ruleId}</div><div className="mt-1 text-xs text-ops-muted">{row.target?.groupName || row.target?.guildId || row.target?.chatId} / {destinationLabel(row.target)}</div></td><td className="px-5 py-4"><StatusPill tone={row.status === "success" ? "green" : "amber"}>{statusLabel(row.status)}</StatusPill></td><td className="px-5 py-4">{row.attempts}</td><td className="px-5 py-4 text-xs">{row.publisherProgress?.length ? `已回写 ${row.publisherProgress.length} 步` : "—"}</td><td className="px-5 py-4 font-mono text-xs">{row.targetMessageIds?.length ? row.targetMessageIds.join(", ") : row.targetMessageId || "—"}</td><td className="max-w-64 break-words px-5 py-4 text-xs text-[#a04a3d]">{row.error || "—"}</td><td className="px-5 py-4">{row.status === "failed" ? <SmallButton disabled={Boolean(busy)} onClick={() => onRetry(row.id)}>重试目标</SmallButton> : "—"}</td></tr>) : <tr><td className="px-5 py-8 text-center font-bold text-ops-muted" colSpan={8}>暂无运行记录。</td></tr>}</tbody></table></div></Card>;
}

function ValidationPanel({ result, onClose }) { return <Card className="mb-5 p-5"><div className="flex items-center justify-between"><h2 className="text-lg font-black">配置验证 · {result.ok ? "通过" : "存在问题"}</h2><SmallButton onClick={onClose}>关闭</SmallButton></div><div className="mt-3 grid gap-2 md:grid-cols-2">{result.checks?.map((check) => <div className="flex gap-2 rounded-lg bg-[#f7f9f8] p-3 text-sm" key={check.key}><span>{check.ok ? "✅" : "❌"}</span><div><strong>{check.key}</strong><p className="mt-1 text-ops-muted">{check.message}</p></div></div>)}</div></Card>; }
function Summary({ label, value, detail }) { return <Card className="p-4"><div className="text-xs font-bold text-ops-muted">{label}</div><div className="mt-1 text-2xl font-black">{value}</div><div className="mt-1 text-xs text-ops-muted">{detail}</div></Card>; }
function Toggle({ checked, label, onChange }) { return <label className="flex min-h-10 items-center gap-3 text-sm font-bold"><input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />{label}</label>; }
function SmallButton({ children, danger = false, disabled = false, onClick }) { return <button className={`min-h-9 rounded-lg border px-3 text-xs font-black disabled:opacity-40 ${danger ? "border-[#d85f5f] text-[#b94141]" : "border-ops-line text-[#33423b]"}`} disabled={disabled} onClick={onClick} type="button">{children}</button>; }

function automationTargetOptions(groups, discordState) {
  return [...targetOptions(groups), ...buildDiscordDistributionTargetOptions(discordState)];
}
function destinationCtaTargetOptions(groups, discordState) {
  return [...buildDistributionTargetOptions(groups), ...buildDiscordDistributionTargetOptions(discordState)];
}
function targetOptions(groups) {
  return buildDistributionTargetOptions(groups).filter((option) => option.target?.chatType !== "channel");
}
function sourceOptions(groups) { return buildDistributionSourceOptions(groups); }
function targetKey(value) { return value?.platform === "discord" ? `discord:${value.guildId}:${value.channelId}` : value?.chatType === "channel" ? `${value.chatId}:channel` : `${value.chatId}:${Number(value.threadId || 0)}`; }
function destinationCtaConfigKey(value) { return value?.platform === "discord" ? `discord:${value.channelId}` : value?.chatType === "channel" ? `telegram:${value.chatId}:channel` : `telegram:${value.chatId}:${Number(value.threadId || 0)}`; }
function normalizeFormTargetCta(input = {}) {
  const ctaText = String(input?.ctaText ?? input?.text ?? "").trim();
  const ctaUrl = String(input?.ctaUrl ?? input?.url ?? "").trim();
  const rawEnabled = input?.ctaEnabled ?? input?.enabled;
  const ctaEnabled = rawEnabled === true || (rawEnabled !== false && Boolean(ctaText || ctaUrl));
  return { ctaEnabled, ctaText, ctaUrl };
}
function retainTargetCtas(value = {}, selected = []) {
  const allowed = new Set(selected);
  return Object.fromEntries(Object.entries(value || {}).filter(([key]) => allowed.has(key)));
}
function targetCtasFromTargets(targets = []) {
  return Object.fromEntries((targets || [])
    .map((target) => [targetKey(target), normalizeFormTargetCta(target)])
    .filter(([, cta]) => cta.ctaEnabled || cta.ctaText || cta.ctaUrl));
}
function targetCtaCount(targets = []) {
  return (targets || []).filter((target) => {
    const cta = normalizeFormTargetCta(target);
    return cta.ctaEnabled && (cta.ctaText || cta.ctaUrl);
  }).length;
}
function sourceKey(value) { return !value?.chatId ? "" : value.chatType === "channel" ? `${value.chatId}:channel` : `${value.chatId}:${Number(value.threadId || 0)}`; }
function destinationLabel(value) { return distributionDestinationLabel(value); }
function labelFor(options, value) { return options.find(([key]) => key === value)?.[1] || value || "未配置"; }
function messageType(payload = {}, mediaGroupId) { if (mediaGroupId) return "相册"; if (payload.photo) return "图片"; if (payload.video) return "视频"; if (payload.document) return "文件"; if (payload.audio || payload.voice) return "音频"; if (payload.animation) return "动图"; return "文字"; }
function statusLabel(value) { return ({ success: "成功", failed: "失败", pending: "待执行", sending: "发送中", partial: "部分成功", skipped: "已跳过", duplicate: "已去重" })[value] || value; }
function formatTime(value) { return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium", hour12: false }).format(new Date(value)) : "—"; }
function stripTelegramHtml(value) { return String(value || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim(); }
