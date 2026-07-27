"use client";

import { useEffect, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import LiveStatusStamp from "../components/LiveStatusStamp";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../components/ui";
import { useLiveAutoRefresh } from "../hooks/useLiveAutoRefresh";
import { defaultTopicTemplate, migrateTopicTemplateList, topicNameWithSequence } from "../../templates.mjs";
import { buildInitializationChecklist, getBotOperationalStatus } from "../../lib/live-status.mjs";
import { selectPreferredInitializationGroup } from "../../lib/telegram-discovery.mjs";
import { isRetiredTelegramGroup } from "../../lib/distribution-ui.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "../../lib/workspace-client";

const defaultTopics = defaultTopicTemplate.map((topic) => [topic.id, topic.emoji, topicNameWithSequence(topic), topic.attribute, topic.announcement || "", topic.imageUrl || ""]);
const defaultTopicIds = defaultTopics.map((topic) => String(topic[0]));
const currentBotFallback = [
  { name: "AdminBot", roleKey: "admin", username: "Bonnie_geniustrader_bot", role: "目标群发现 / Topic 初始化 / 权限复核" },
  { name: "SpeakerBot", roleKey: "speaker", username: "Satoshi_geniustrader_bot", role: "Trader 私聊接收 / 订单核验" },
  { name: "ForwardBot", roleKey: "forward", username: "Biupa_geniustrader_bot", role: "Telegram 来源监听 / 广播入站" }
];

export default function NewGroupPage() {
  const [log, setLog] = useState("准备初始化新群。");
  const [topics, setTopics] = useState(defaultTopics);
  const [selectedTopicIds, setSelectedTopicIds] = useState(defaultTopicIds);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [chatId, setChatId] = useState("");
  const [botRole, setBotRole] = useState("admin");
  const [bots, setBots] = useState(currentBotFallback);
  const [groups, setGroups] = useState([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [generatedAt, setGeneratedAt] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [discoveryStatus, setDiscoveryStatus] = useState("正在识别群与机器人...");
  const [dryRun, setDryRun] = useState(true);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState("正在读取云端草稿...");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ active: false, value: 0, label: "等待执行" });
  const selectedGroup = groups.find((group) => String(group.chatId) === String(chatId)) || null;
  const selectedTopics = topics.filter((topic) => selectedTopicIds.includes(String(topic[0])));
  const checklist = buildInitializationChecklist({ groupName, topics: selectedTopics, group: selectedGroup, generatedAt });

  useEffect(() => {
    initialize();
  }, []);

  useEffect(() => {
    if (!draftLoaded) return undefined;
    setSaveStatus("正在保存到云端...");
    const timer = window.setTimeout(() => {
      persistDraft()
        .then(() => setSaveStatus(`已自动保存 · ${new Date().toLocaleTimeString()}`))
        .catch((error) => setSaveStatus(`保存失败：${error.message}`));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [draftLoaded, groupName, groupDescription, chatId, botRole, dryRun, topics, selectedTopicIds]);

  useLiveAutoRefresh(
    () => refreshGroups(chatId, { silent: true }),
    { enabled: groupsLoaded && !running }
  );

  async function initialize() {
    let savedDraft = null;
    try {
      const saved = await loadWorkspaceState("new-group");
      savedDraft = saved.state;
      if (savedDraft) {
        setGroupDescription(savedDraft.groupDescription || "");
        setBotRole("admin");
        const restoredTopics = savedDraft.topics?.length
          ? migrateTopicTemplateList(savedDraft.topics).map((topic) => {
            return [topic.id, topic.emoji, topic.name, topic.attribute, topic.announcement || "", topic.imageUrl || ""];
          })
          : defaultTopics;
        setTopics(restoredTopics);
        const availableIds = restoredTopics.map((topic) => String(topic[0]));
        const restoredSelection = Array.isArray(savedDraft.selectedTopicIds)
          ? savedDraft.selectedTopicIds.map(String).filter((id) => availableIds.includes(id))
          : availableIds;
        setSelectedTopicIds(restoredSelection);
        setSaveStatus(saved.updatedAt ? `已恢复云端草稿 · ${new Date(saved.updatedAt).toLocaleString()}` : "已恢复云端草稿");
      } else {
        setSaveStatus("尚无云端草稿，修改后将自动保存");
      }
    } catch (error) {
      setSaveStatus(`草稿读取失败：${error.message}`);
    }
    await refreshGroups(savedDraft?.chatId || "");
    setDraftLoaded(true);
  }

  async function persistDraft() {
    return saveWorkspaceState("new-group", {
      groupName,
      groupDescription,
      chatId,
      botRole,
      dryRun: true,
      topics: topics.map(([id, emoji, name, attribute, announcement, imageUrl]) => ({ id, emoji, name, attribute, announcement, imageUrl })),
      selectedTopicIds
    });
  }

  async function refreshGroups(preferredChatId = chatId, { silent = false } = {}) {
    if (refreshing) return;
    setRefreshing(true);
    if (!silent) {
      setGroupsLoaded(false);
      setDiscoveryStatus("正在从 Telegram 实时刷新...");
    }
    try {
      const response = await fetch(`/api/chats?refresh=${Date.now()}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "群发现失败");
      const liveGroups = (data.chats || []).filter((group) => group.type !== "channel" && !isRetiredTelegramGroup(group));
      setGroups(liveGroups);
      setBots(data.bots?.length ? data.bots : currentBotFallback);
      setGeneratedAt(data.generatedAt || new Date().toISOString());
      setRefreshError("");
      const preferred = selectPreferredInitializationGroup(liveGroups, preferredChatId);
      if (preferred) {
        setChatId(String(preferred.chatId));
        setGroupName(preferred.title);
      } else {
        setChatId("");
        setGroupName("");
      }
      const readyCount = liveGroups.filter((group) => group.readyForInitialization).length;
      if (liveGroups.length && preferredChatId && !preferred) {
        setDiscoveryStatus(`已识别 ${liveGroups.length} 个群，但上次保存的群已不在实时列表；请重新选择群`);
      } else {
        setDiscoveryStatus(liveGroups.length ? `已识别 ${liveGroups.length} 个群；${readyCount} 个群已满足 AdminBot 初始化权限` : "未识别到群，请确认 AdminBot 已加入并重新刷新");
      }
      return preferred;
    } catch (error) {
      setRefreshError(error.message);
      if (!silent) setDiscoveryStatus(`刷新失败：${error.message}`);
    } finally {
      setGroupsLoaded(true);
      setRefreshing(false);
    }
  }

  async function verifyEnteredGroup({ announce = true } = {}) {
    const normalizedChatId = chatId.trim();
    if (!/^-100\d+$/.test(normalizedChatId)) {
      throw new Error("请输入有效的 Telegram 超级群 ID（以 -100 开头）");
    }
    setRefreshing(true);
    if (announce) setDiscoveryStatus("正在由 AdminBot 直接检查群、Topics 与初始化权限...");
    try {
      const response = await fetch("/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: normalizedChatId })
      });
      const data = await response.json();
      if (!response.ok || !data.ok || !data.group) throw new Error(data.error || "群检测失败");
      const verifiedGroup = data.group;
      const mergedGroups = [verifiedGroup, ...groups.filter((group) => String(group.chatId) !== normalizedChatId)];
      const saveResponse = await fetch("/api/group-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groups: mergedGroups })
      });
      const saved = await saveResponse.json();
      if (!saveResponse.ok || !saved.ok) throw new Error(saved.error || "群配置保存失败");
      setGroups((saved.groups || mergedGroups).filter((group) => group.type !== "channel" && !isRetiredTelegramGroup(group)));
      setBots(data.bots?.length ? data.bots : currentBotFallback);
      setGeneratedAt(data.generatedAt || new Date().toISOString());
      setRefreshError("");
      setChatId(String(verifiedGroup.chatId));
      setGroupName(verifiedGroup.title);
      setDiscoveryStatus(`${verifiedGroup.title} 已直接核验：${verifiedGroup.adminBotReady ? "AdminBot 初始化权限已通过" : verifiedGroup.initializationBlockReason || "AdminBot 初始化权限待处理"}`);
      return verifiedGroup;
    } finally {
      setRefreshing(false);
    }
  }

  function selectGroup(value) {
    const group = groups.find((item) => String(item.chatId) === String(value));
    setChatId(value);
    setGroupName(group?.title || "");
  }

  function changeChatId(value) {
    const group = groups.find((item) => String(item.chatId) === String(value));
    setChatId(value);
    setGroupName(group?.title || "");
  }

  function updateTopic(index, field, value) {
    setTopics((current) => current.map((topic, topicIndex) => {
      if (topicIndex !== index) return topic;
      const next = [...topic];
      next[field] = value;
      return next;
    }));
  }

  function toggleTopic(topicId) {
    const normalizedId = String(topicId);
    setSelectedTopicIds((current) => current.includes(normalizedId)
      ? current.filter((id) => id !== normalizedId)
      : topics.map((topic) => String(topic[0])).filter((id) => current.includes(id) || id === normalizedId));
  }

  async function run() {
    if (running) return;
    if (!selectedTopicIds.length) {
      setLog("至少选择一个需要搭建的 Topic。");
      return;
    }
    if (!/^-100\d+$/.test(chatId.trim())) {
      setLog("请填写有效的 Telegram 超级群 ID（以 -100 开头）。");
      return;
    }
    setRunning(true);
    setLog("正在通过 AdminBot 直接核验群、Topics 与初始化权限...");
    let verifiedGroup;
    try {
      verifiedGroup = await verifyEnteredGroup({ announce: false });
    } catch (error) {
      setLog(`初始化检查失败\n\n${error.message}`);
      setRunning(false);
      setDryRun(true);
      return;
    }
    if (!verifiedGroup.readyForInitialization) {
      setLog([
        "初始化已阻止，尚未向 Telegram 执行任何修改。",
        verifiedGroup.initializationBlockReason || "这个群尚未满足初始化条件。",
        "请由群主在 Telegram 检查：群资料 → 编辑 → Topics（话题），以及 AdminBot 管理员权限；完成后回到后台点击“刷新目标群”。"
      ].join("\n\n"));
      setRunning(false);
      setDryRun(true);
      return;
    }
    setProgress({ active: true, value: 8, label: "初始化群与 Topic" });
    setLog("正在检查群权限并准备初始化...");
    let currentProgress = 8;
    const timer = window.setInterval(() => {
      currentProgress = Math.min(92, currentProgress + Math.max(1, Math.round((92 - currentProgress) / 8)));
      setProgress({ active: true, value: currentProgress, label: "初始化群与 Topic" });
    }, 3000);

    try {
      await persistDraft();
      setSaveStatus(`已保存 · ${new Date().toLocaleTimeString()}`);
      const response = await fetch("/api/scripts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scriptId: "newGroup",
          payload: {
            mode: dryRun ? "dry-run" : "production",
            groupName,
            groupDescription,
            chatId,
            botRole: "admin",
            topics: topics.map(([id, emoji, name, attribute, announcement, imageUrl]) => ({ id, emoji, name, attribute, announcement, imageUrl })),
            selectedTopicIds,
          }
        })
      });
      const data = await response.json();
      setProgress({ active: true, value: data.ok ? 100 : 96, label: data.ok ? "执行完成" : "执行结束，请查看结果" });
      if (data.ok) {
        const refreshed = await refreshGroups(chatId);
        setLog([dryRun ? "安全检查完成" : "初始化完成，Telegram 群与 Topic 状态已刷新", refreshed?.title ? `目标群：${refreshed.title}` : "", data.stdout, data.stderr].filter(Boolean).join("\n\n"));
      } else {
        setLog(["初始化检查失败", data.stdout, data.stderr, data.error].filter(Boolean).join("\n\n"));
      }
    } catch (error) {
      setProgress({ active: true, value: 96, label: "执行结束，请查看结果" });
      setLog(`请求失败：${error.message}`);
    } finally {
      window.clearInterval(timer);
      setRunning(false);
      setDryRun(true);
    }
  }
  return (
    <ConsoleShell>
      <PageHeader title="新群初始化" desc="目标群只需将 @Serenity_Crypto 与 AdminBot 设为管理员：@Serenity_Crypto 负责官方身份发布，AdminBot 负责群发现、Topic 初始化和权限复核；SpeakerBot / ForwardBot 无需加入目标群。" />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="p-6">
          <div className="mb-5 rounded-lg border border-ops-line bg-[#fbfcfb] p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-end">
              <div className="flex-1"><Field label="已识别群"><select className={`${inputClass} w-full`} disabled={!groupsLoaded || refreshing} value={chatId} onChange={(event) => selectGroup(event.target.value)}>{!groupsLoaded ? <option value="">正在读取 Telegram 群...</option> : groups.length ? <><option value="">请选择已识别群</option>{groups.map((group) => <option disabled={!group.readyForInitialization} key={group.chatId} value={group.chatId}>{group.title} · {group.readyForInitialization ? "可初始化" : group.initializationBlockReason || "不可初始化"}</option>)}</> : <option value="">暂未识别到群</option>}</select></Field></div>
              <button className="min-h-11 rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent disabled:opacity-60" disabled={refreshing} onClick={() => refreshGroups(chatId)} type="button">{refreshing ? "刷新中..." : "刷新目标群"}</button>
            </div>
            <p className="mt-2 text-sm font-bold text-ops-muted">{discoveryStatus}</p>
            <p className="mt-1 text-xs font-bold text-ops-muted">无需在这台 Mac 登录 Bot；AdminBot 始终通过服务器端 Bot API 复核目标群与 Topic。发布前还会检查 @Serenity_Crypto 的目标白名单。</p>
            <div className="mt-3"><LiveStatusStamp generatedAt={generatedAt} error={refreshError} refreshing={refreshing} /></div>
            {selectedGroup && !selectedGroup.readyForInitialization && <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800">{selectedGroup.initializationBlockReason}。Topics 必须由群主在 Telegram 客户端开启。</p>}
            <p className="mt-1 text-xs font-bold text-ops-accent">{saveStatus}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="目标群名称（来自 Telegram，可修改）"><input className={inputClass} value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="选择或检测群后自动读取" /></Field>
            <Field label="管理机器人"><div className={`${inputClass} flex items-center bg-[#f7f9f8] font-bold`}>AdminBot · @{bots.find((bot) => bot.roleKey === "admin")?.username || "Bonnie_geniustrader_bot"}</div></Field>
            <Field label="群 ID"><div className="flex gap-2"><input className={`${inputClass} min-w-0 flex-1`} value={chatId} onChange={(event) => changeChatId(event.target.value)} placeholder="-100xxxxxxxxxx" /><button className="min-h-11 shrink-0 rounded-lg border border-ops-accent px-3 text-xs font-black text-ops-accent disabled:opacity-60" disabled={refreshing || running} onClick={() => verifyEnteredGroup().catch((error) => setDiscoveryStatus(`检测失败：${error.message}`))} type="button">直接检测</button></div></Field>
            <Field label="分区模板"><select className={inputClass}><option>模版</option></select></Field>
          </div>
          <Field label="群简介（选填）"><textarea className={`${inputClass} mt-4 min-h-24 py-3`} value={groupDescription} onChange={(event) => setGroupDescription(event.target.value)} placeholder="输入群简介内容，可选" /></Field>
          <label className="mt-4 flex items-start gap-3 rounded-lg border border-ops-line bg-[#fbfcfb] p-4 text-sm">
            <input className="mt-0.5" type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} />
            <span><b>安全测试模式</b><br /><span className="text-ops-muted">默认开启，只预览 Topic 图标、图文公告和 Topic 操作，不向 Telegram 发送。取消勾选才会真实建群配置。</span></span>
          </label>
          <button
            className="mt-5 rounded-lg bg-ops-accent px-5 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={running || !selectedTopicIds.length}
            onClick={run}
          >
            {running ? "正在设置..." : dryRun ? "安全测试新群" : "批量设置新群"}
          </button>
          {progress.active && (
            <div className="mt-3 rounded-lg border border-ops-line bg-white p-3">
              <div className="flex items-center justify-between text-xs font-black text-ops-muted">
                <span>{progress.label}</span>
                <span>{progress.value}%</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#e7eee9]">
                <div className="h-full rounded-full bg-ops-accent transition-all duration-700" style={{ width: `${progress.value}%` }} />
              </div>
            </div>
          )}
        </Card>
        <Card className="p-5">
          <h2 className="text-lg font-black">本次初始化准备</h2>
          <p className="mt-1 text-xs leading-5 text-ops-muted">“已配置”只表示表单内容准备完成；群权限和 Bot 状态来自 Telegram 实时核验。</p>
          <div className="mt-4 grid gap-3 text-sm">
            {checklist.map((item) => {
              const ready = item.kind === "live" ? item.value === "已通过" : !["待填写", "待配置", "未配置"].includes(item.value);
              return <div className="flex items-center justify-between gap-3" key={item.label}><span>{item.label}</span><StatusPill tone={ready ? "green" : "amber"}>{item.value}</StatusPill></div>;
            })}
          </div>
          <div className="mt-5 border-t border-ops-line pt-5">
            <h3 className="font-black">发布与后台能力</h3>
            <div className="mt-3 grid gap-2 text-sm">
              <div className="rounded-lg bg-[#fbfcfb] px-3 py-2"><div className="flex items-center justify-between gap-2"><strong>@Serenity_Crypto</strong><StatusPill tone="green">主发布账号</StatusPill></div><div className="mt-1 text-xs text-ops-muted">需加入目标群并设为管理员；自动发布时显示目标群名称和群头像。</div></div>
              {bots.map((bot) => {
                const targetGroupRequired = bot.name === "AdminBot";
                const botStatus = getBotOperationalStatus({ bot, group: targetGroupRequired ? selectedGroup : null, generatedAt });
                return <div className="rounded-lg bg-[#fbfcfb] px-3 py-2" key={bot.name}><div className="flex items-center justify-between gap-2"><strong>{bot.name}</strong><StatusPill tone={botStatus.tone}>{botStatus.label}</StatusPill></div><div className="mt-1 break-all text-xs text-ops-muted">@{bot.username || bot.expectedUsername}</div><div className="mt-1 text-xs text-ops-muted">{bot.role}</div><div className="mt-1 text-xs font-bold text-ops-muted">{targetGroupRequired ? "需加入目标群并设为管理员" : "无需加入目标群"}</div><div className="mt-1 text-xs text-ops-muted">{botStatus.detail}</div></div>;
              })}
            </div>
          </div>
          <div className="mt-5 border-t border-ops-line pt-5">
            <h3 className="font-black">本次搭建 Topic</h3>
            <div className="mt-3 grid gap-2 text-sm">
              {selectedTopics.map((topic) => <div className="rounded-lg bg-[#fbfcfb] px-3 py-2" key={topic[0]}>{topic[1]} {topic[2]}</div>)}
              {!selectedTopics.length && <div className="rounded-lg bg-amber-50 px-3 py-2 font-bold text-amber-800">尚未选择 Topic</div>}
            </div>
          </div>
          <pre className="mt-5 max-h-48 overflow-auto rounded-lg bg-[#101815] p-3 text-xs leading-5 text-[#d8f9e7]">{log}</pre>
        </Card>
      </div>
      <Card className="mt-5 overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-ops-line p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-black">分区模板预览</h2>
            <p className="mt-1 text-sm text-ops-muted">勾选本次需要搭建的 Topic；图标、名称和属性仍可逐项调整。General Chat 为 Telegram 系统话题，不计入 1–7。</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill tone={selectedTopicIds.length ? "green" : "amber"}>已选 {selectedTopicIds.length}/{topics.length}</StatusPill>
            <button className="rounded-lg border border-ops-line px-3 py-2 text-xs font-black" onClick={() => setSelectedTopicIds(topics.map((topic) => String(topic[0])))} type="button">全选</button>
            <button className="rounded-lg border border-ops-line px-3 py-2 text-xs font-black" onClick={() => setSelectedTopicIds([])} type="button">清空</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted">
              <tr><th className="px-5 py-3">搭建</th><th className="px-5 py-3">序号</th><th className="px-5 py-3">Topic 图标</th><th className="px-5 py-3">Topic 名称</th><th className="px-5 py-3">属性</th></tr>
            </thead>
            <tbody>
              {topics.map((topic, index) => (
                <tr className={`border-t border-ops-line ${selectedTopicIds.includes(String(topic[0])) ? "" : "opacity-55"}`} key={topic[0]}>
                  <td className="px-5 py-3"><input aria-label={`搭建 ${topic[2]}`} checked={selectedTopicIds.includes(String(topic[0]))} onChange={() => toggleTopic(topic[0])} type="checkbox" /></td>
                  <td className="px-5 py-3 font-bold">{topic[0]}</td>
                  <td className="px-5 py-3"><input className={`${inputClass} w-20`} value={topic[1]} onChange={(event) => updateTopic(index, 1, event.target.value)} /></td>
                  <td className="px-5 py-3"><input className={inputClass} value={topic[2]} onChange={(event) => updateTopic(index, 2, event.target.value)} /></td>
                  <td className="px-5 py-3"><select className={inputClass} value={topic[3]} onChange={(event) => updateTopic(index, 3, event.target.value)}><option>关闭话题</option><option>频道禁言</option><option>交流频道</option></select></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </ConsoleShell>
  );
}
