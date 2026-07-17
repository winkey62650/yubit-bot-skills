"use client";

import { useEffect, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../components/ui";
import { defaultTopicTemplate, migrateTopicTemplateList, topicNameWithSequence } from "../../templates.mjs";
import { selectPreferredInitializationGroup } from "../../lib/telegram-discovery.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "../../lib/workspace-client";

const defaultTopics = defaultTopicTemplate.map((topic) => [topic.id, topic.emoji, topicNameWithSequence(topic), topic.attribute, topic.announcement || "", topic.imageUrl || ""]);
const currentBotFallback = [
  { name: "AdminBot", roleKey: "admin", username: "Bonnie_geniustrader_bot", role: "群管理 / 建群 / 公告" },
  { name: "SpeakerBot", roleKey: "speaker", username: "Satoshi_geniustrader_bot", role: "新闻 / 分析 / 信号发布" },
  { name: "ForwardBot", roleKey: "forward", username: "Biupa_geniustrader_bot", role: "广播 / 代理社媒转发" }
];

export default function NewGroupPage() {
  const [log, setLog] = useState("准备初始化新群。");
  const [topics, setTopics] = useState(defaultTopics);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [chatId, setChatId] = useState("");
  const [botRole, setBotRole] = useState("admin");
  const [bots, setBots] = useState(currentBotFallback);
  const [groups, setGroups] = useState([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [discoveryStatus, setDiscoveryStatus] = useState("正在识别群与机器人...");
  const [dryRun, setDryRun] = useState(true);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState("正在读取云端草稿...");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ active: false, value: 0, label: "等待执行" });
  const selectedGroup = groups.find((group) => String(group.chatId) === String(chatId)) || null;

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
  }, [draftLoaded, groupName, groupDescription, chatId, botRole, dryRun, topics]);

  async function initialize() {
    let savedDraft = null;
    try {
      const saved = await loadWorkspaceState("new-group");
      savedDraft = saved.state;
      if (savedDraft) {
        setGroupDescription(savedDraft.groupDescription || "");
        setBotRole("admin");
        if (savedDraft.topics?.length) {
          setTopics(migrateTopicTemplateList(savedDraft.topics).map((topic) => {
            return [topic.id, topic.emoji, topic.name, topic.attribute, topic.announcement || "", topic.imageUrl || ""];
          }));
        }
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
      topics: topics.map(([id, emoji, name, attribute, announcement, imageUrl]) => ({ id, emoji, name, attribute, announcement, imageUrl }))
    });
  }

  async function refreshGroups(preferredChatId = chatId) {
    if (refreshing) return;
    setRefreshing(true);
    setGroupsLoaded(false);
    setDiscoveryStatus("正在从 Telegram 实时刷新...");
    try {
      const response = await fetch(`/api/chats?refresh=${Date.now()}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "群发现失败");
      const liveGroups = data.chats || [];
      setGroups(liveGroups);
      setBots(data.bots?.length ? data.bots : currentBotFallback);
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
        setDiscoveryStatus(liveGroups.length ? `已识别 ${liveGroups.length} 个群；${readyCount} 个群已开启 Topics 且三个 Bot 均为管理员` : "未识别到群，请确认 Bot 已加入并重新刷新");
      }
    } catch (error) {
      setDiscoveryStatus(`刷新失败：${error.message}`);
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
    if (announce) setDiscoveryStatus("正在由服务器上的三个 Bot 直接检查群与管理员权限...");
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
      setGroups(saved.groups || mergedGroups);
      setBots(data.bots?.length ? data.bots : currentBotFallback);
      setChatId(String(verifiedGroup.chatId));
      setGroupName(verifiedGroup.title);
      setDiscoveryStatus(`${verifiedGroup.title} 已直接核验：三个 Bot 管理员 ${verifiedGroup.adminBotCount}/3，${verifiedGroup.canUseTopics ? "Topics 已开启" : "Topics 未开启"}`);
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

  async function run() {
    if (running) return;
    if (!/^-100\d+$/.test(chatId.trim())) {
      setLog("请填写有效的 Telegram 超级群 ID（以 -100 开头）。");
      return;
    }
    setRunning(true);
    setLog("正在通过三个服务器端 Bot 直接核验群与管理员权限...");
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
        "请由群主在 Telegram 打开：群资料 → 编辑 → Topics（话题），开启后回到后台点击“刷新群与 Bot”。"
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
            topics: topics.map(([id, emoji, name, attribute, announcement, imageUrl]) => ({ id, emoji, name, attribute, announcement, imageUrl }))
          }
        })
      });
      const data = await response.json();
      setProgress({ active: true, value: data.ok ? 100 : 96, label: data.ok ? "执行完成" : "执行结束，请查看结果" });
      setLog([data.ok ? "初始化检查完成" : "初始化检查失败", data.stdout, data.stderr, data.error].filter(Boolean).join("\n\n"));
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
      <PageHeader title="新群初始化" desc="先识别已开启 Topics、且三个现用 Bot 都是管理员的超级群，再一键完成群资料、分区、公告和置顶配置。" />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="p-6">
          <div className="mb-5 rounded-lg border border-ops-line bg-[#fbfcfb] p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-end">
              <div className="flex-1"><Field label="已识别群"><select className={`${inputClass} w-full`} disabled={!groupsLoaded || refreshing} value={chatId} onChange={(event) => selectGroup(event.target.value)}>{!groupsLoaded ? <option value="">正在读取 Telegram 群...</option> : groups.length ? <><option value="">请选择已识别群</option>{groups.map((group) => <option disabled={!group.readyForInitialization} key={group.chatId} value={group.chatId}>{group.title} · {group.readyForInitialization ? "可初始化" : group.initializationBlockReason || "不可初始化"}</option>)}</> : <option value="">暂未识别到群</option>}</select></Field></div>
              <button className="min-h-11 rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent disabled:opacity-60" disabled={refreshing} onClick={() => refreshGroups(chatId)} type="button">{refreshing ? "刷新中..." : "刷新群与 Bot"}</button>
            </div>
            <p className="mt-2 text-sm font-bold text-ops-muted">{discoveryStatus}</p>
            <p className="mt-1 text-xs font-bold text-ops-muted">无需在这台 Mac 登录三个 Bot；这里始终通过服务器端 Bot API 复核。</p>
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
            disabled={running}
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
          <h2 className="text-lg font-black">初始化清单</h2>
          <div className="mt-4 grid gap-3 text-sm">
            {["设置群资料", "创建分区", "设置公告", "置顶消息"].map((item) => <div className="flex items-center justify-between" key={item}><span>{item}</span><StatusPill>已就绪</StatusPill></div>)}
            <div className="flex items-center justify-between"><span>权限检查</span><StatusPill tone="amber">待执行</StatusPill></div>
          </div>
          <div className="mt-5 border-t border-ops-line pt-5">
            <h3 className="font-black">当前三个 Bot</h3>
            <div className="mt-3 grid gap-2 text-sm">
              {bots.map((bot) => <div className="rounded-lg bg-[#fbfcfb] px-3 py-2" key={bot.name}><div className="flex items-center justify-between gap-2"><strong>{bot.name}</strong><StatusPill tone={bot.status === "在线" ? "green" : "amber"}>{bot.status || "等待刷新"}</StatusPill></div><div className="mt-1 break-all text-xs text-ops-muted">@{bot.username || bot.expectedUsername}</div></div>)}
            </div>
          </div>
          <div className="mt-5 border-t border-ops-line pt-5">
            <h3 className="font-black">建群默认关闭话题</h3>
            <div className="mt-3 grid gap-2 text-sm">
              {topics.filter((topic) => topic[3] === "关闭话题").map((topic) => (
                <label className="flex items-center justify-between rounded-lg bg-[#fbfcfb] px-3 py-2" key={topic}>
                  <span>{topic[1]} {topic[2]}</span>
                  <input type="checkbox" defaultChecked />
                </label>
              ))}
            </div>
          </div>
          <pre className="mt-5 max-h-48 overflow-auto rounded-lg bg-[#101815] p-3 text-xs leading-5 text-[#d8f9e7]">{log}</pre>
        </Card>
      </div>
      <Card className="mt-5 overflow-hidden">
        <div className="border-b border-ops-line p-5">
          <h2 className="text-xl font-black">分区模板预览</h2>
          <p className="mt-1 text-sm text-ops-muted">图标会设置为 Telegram Topic 的官方自定义图标，不会重复写入名称；关闭话题表示创建后默认关闭该 Topic。</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted">
              <tr><th className="px-5 py-3">序号</th><th className="px-5 py-3">Topic 图标</th><th className="px-5 py-3">Topic 名称</th><th className="px-5 py-3">属性</th></tr>
            </thead>
            <tbody>
              {topics.map((topic, index) => (
                <tr className="border-t border-ops-line" key={topic[0]}>
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
