"use client";

import { useEffect, useMemo, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, Field, PageHeader, inputClass } from "../components/ui";

const initialRoutes = [
  { id: "news-market-events", group: "YUBIT test", topic: "Market Events", type: "新闻配置", config: "Crypto News Default", bot: "Trader1", status: "已启用" },
  { id: "signal-market-analysis", group: "YUBIT test", topic: "Market Analysis - Crypto/Stocks/TradFi", type: "信号配置", config: "Futures SMA", bot: "Trader1", status: "已启用" },
  { id: "broadcast-market-events", group: "YUBIT test", topic: "Market Events", type: "广播", config: "Demo 群全部消息广播", bot: "YUBITadmin", frequency: "实时", status: "已启用" },
  { id: "ricky-social", group: "YUBIT test", topic: "Ricky's Trading Zone", type: "代理社媒", config: "Ricky 社媒转发包", bot: "YUBITadmin", frequency: "每 5 分钟", status: "已启用" },
  { id: "official-updates", group: "YUBIT Winkey Main", topic: "YUBIT Updates", type: "新闻配置", config: "Official Updates", bot: "YUBITadmin", status: "待检查" }
];

const groupOptions = ["YUBIT test", "YUBIT Winkey Main"];
const fallbackGroups = [
  { title: "YUBIT test", topics: [{ name: "Market Events" }, { name: "Market Analysis - Crypto/Stocks/TradFi" }, { name: "YUBIT Updates" }, { name: "Ricky's Trading Zone" }] },
  { title: "YUBIT Winkey Main", topics: [{ name: "YUBIT Updates" }] }
];
const configPools = {
  "新闻配置": [
    { name: "Crypto News Default", bot: "Trader1", frequency: "每 15 分钟" },
    { name: "Smart Money Tracker", bot: "Trader1", frequency: "每 15 分钟" },
    { name: "Daily Morning Brief", bot: "Trader1", frequency: "每日 08:30" },
    { name: "Daily Chart Analysis", bot: "Trader1", frequency: "每日 09:00" },
    { name: "Cointelegraph News", bot: "Trader1", frequency: "实时" },
    { name: "CoinDesk News", bot: "Trader1", frequency: "每 30 分钟" },
    { name: "Official Updates", bot: "YUBITadmin", frequency: "实时" }
  ],
  "信号配置": [
    { name: "Futures SMA", bot: "Trader1", frequency: "每 15 分钟" },
    { name: "TradFi SMA", bot: "Trader1", frequency: "每 30 分钟" }
  ],
  "广播": [
    { name: "Demo 群全部消息广播", bot: "YUBITadmin", frequency: "实时" },
    { name: "Demo 群 Signal 标签广播", bot: "YUBITadmin", frequency: "实时" },
    { name: "Demo 群公告广播", bot: "YUBITadmin", frequency: "实时" }
  ],
  "代理社媒": [
    { name: "Ricky 社媒转发包", bot: "YUBITadmin", frequency: "每 5 分钟" },
    { name: "Jack 社媒转发包", bot: "Jack", frequency: "每 5 分钟" },
    { name: "Tony 社媒转发包", bot: "Tony", frequency: "每 5 分钟" }
  ]
};

export default function GroupConfigPage() {
  const [savedGroups, setSavedGroups] = useState([]);
  const [discoverStatus, setDiscoverStatus] = useState("等待刷新");
  const [routes, setRoutes] = useState(initialRoutes);
  const [groupFilter, setGroupFilter] = useState("全部群");
  const [bindingForm, setBindingForm] = useState({ group: "YUBIT test", topic: "Market Events", type: "新闻配置", config: "Crypto News Default" });
  const [socialPackages, setSocialPackages] = useState([]);

  const dynamicGroupOptions = useMemo(() => {
    const savedNames = savedGroups.map((group) => group.title).filter(Boolean);
    return savedNames.length ? savedNames : groupOptions;
  }, [savedGroups]);
  const currentGroups = useMemo(() => savedGroups.length ? savedGroups : fallbackGroups, [savedGroups]);
  const dynamicConfigPools = useMemo(() => ({
    ...configPools,
    "代理社媒": socialPackages.length
      ? socialPackages.map((pkg) => ({ name: pkg.name, bot: pkg.bot || "YUBITadmin", frequency: pkg.frequency || "每 5 分钟" }))
      : configPools["代理社媒"]
  }), [socialPackages]);
  const selectedGroup = useMemo(() => currentGroups.find((group) => group.title === (bindingForm.group || currentGroups[0]?.title)) || currentGroups[0], [bindingForm.group, currentGroups]);
  const topicOptions = selectedGroup?.topics?.length ? selectedGroup.topics : [];
  const configOptions = dynamicConfigPools[bindingForm.type] || [];
  const selectedConfig = configOptions.find((config) => config.name === bindingForm.config) || configOptions[0] || { bot: "", frequency: "" };
  const visibleGroupRoutes = useMemo(() => {
    const knownNames = new Set(currentGroups.map((group) => group.title));
    const activeRoutes = routes.filter((route) => knownNames.has(route.group));
    if (groupFilter === "全部群") return activeRoutes;
    return activeRoutes.filter((route) => route.group === groupFilter);
  }, [currentGroups, groupFilter, routes]);

  useEffect(() => {
    loadSavedGroup();
    loadSocialPackages();
  }, []);

  async function loadSocialPackages() {
    try {
      const response = await fetch("/api/social-packages");
      const data = await response.json();
      setSocialPackages(data.packages || []);
    } catch {}
  }

  async function loadSavedGroup() {
    try {
      const response = await fetch("/api/group-config");
      const data = await response.json();
      if (data.groups?.length) {
        setSavedGroups(data.groups);
        setBindingForm((current) => ({ ...current, group: current.group || data.groups[0].title, topic: current.topic || data.groups[0].topics?.[0]?.name || "" }));
        setDiscoverStatus(`已读取本地配置群：${data.groups.length} 个`);
      }
      if (Array.isArray(data.bindings)) {
        setRoutes(data.bindings);
      }
    } catch (error) {
      setDiscoverStatus(`读取本地群失败：${error.message}`);
    }
  }

  async function discoverChats() {
    setDiscoverStatus("刷新中...");
    try {
      const response = await fetch("/api/chats");
      const data = await response.json();
      const forumChats = (data.chats || []).filter((chat) => chat.canUseTopics);
      const saveResponse = await fetch("/api/group-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groups: forumChats })
      });
      const saved = await saveResponse.json();
      setSavedGroups(saved.groups || []);
      setBindingForm((current) => ({ ...current, group: saved.groups?.[0]?.title || current.group, topic: saved.groups?.[0]?.topics?.[0]?.name || current.topic }));
      setDiscoverStatus(forumChats.length ? `已刷新 ${forumChats.length} 个可配置群` : "未发现可配置群");
    } catch (error) {
      setDiscoverStatus(`发现失败：${error.message}`);
    }
  }

  async function unlinkRoute(id) {
    try {
      const response = await fetch("/api/group-binding-delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id })
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || "解绑失败");
      setRoutes(data.bindings || routes.filter((route) => route.id !== id));
      setDiscoverStatus(`已解绑 ${data.deleted || 1} 条规则，自动发送将在下一轮检查停止。`);
    } catch (error) {
      setDiscoverStatus(`解绑失败：${error.message}`);
    }
  }

  async function testRoute(id) {
    try {
      setDiscoverStatus("正在发送绑定测试...");
      const response = await fetch("/api/group-binding-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id })
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || "测试失败");
      setDiscoverStatus(`测试已发送：${data.config} → ${data.group} / ${data.topic}`);
    } catch (error) {
      setDiscoverStatus(`测试失败：${error.message}`);
    }
  }

  async function saveBindingRule() {
    if (!bindingForm.group || !bindingForm.topic || !selectedConfig.name) {
      setDiscoverStatus("请先选择群、Topic 和配置");
      return;
    }
    const selectedTopic = topicOptions.find((topic) => topic.name === bindingForm.topic);
    const nextRoute = {
      id: `binding-${Date.now()}`,
      group: bindingForm.group,
      topic: bindingForm.topic,
      topicId: selectedTopic?.threadId || null,
      type: bindingForm.type,
      config: selectedConfig.name,
      bot: selectedConfig.bot,
      frequency: selectedConfig.frequency,
      status: "已启用"
    };
    const nextRoutes = [nextRoute, ...routes.filter((route) => !(route.group === nextRoute.group && route.topic === nextRoute.topic && route.config === nextRoute.config))];
    setRoutes(nextRoutes);
    try {
      const response = await fetch("/api/group-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bindings: nextRoutes })
      });
      const data = await response.json();
      setDiscoverStatus(data.ok ? "绑定规则已更新" : data.error || "绑定规则保存失败");
    } catch (error) {
      setDiscoverStatus(`绑定规则保存失败：${error.message}`);
    }
  }

  function updateBindingForm(patch) {
    setBindingForm((current) => {
      const next = { ...current, ...patch };
      if (patch.group) {
        const group = currentGroups.find((item) => item.title === patch.group);
        next.topic = group?.topics?.[0]?.name || "";
      }
      if (patch.type) next.config = dynamicConfigPools[patch.type]?.[0]?.name || "";
      return next;
    });
  }

  return (
    <ConsoleShell>
      <PageHeader title="群配置" desc="配置当前群、Topic 绑定、代理 Topic 和内容分发规则。" />
      <Card className="mb-5 overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-ops-line p-5 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h2 className="text-xl font-black">已配置群</h2>
          </div>
          <button className="min-h-10 rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent" onClick={discoverChats} type="button">配置群刷新</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted">
              <tr><th className="px-5 py-3">群名称</th><th className="px-5 py-3">群 ID</th><th className="px-5 py-3">类型</th><th className="px-5 py-3">Topic</th></tr>
            </thead>
            <tbody>
              {savedGroups.length ? savedGroups.map((group) => (
                <tr className="border-t border-ops-line" key={group.chatId}>
                  <td className="px-5 py-4 font-bold">{group.title}</td>
                  <td className="px-5 py-4 font-mono text-xs">{group.chatId}</td>
                  <td className="px-5 py-4">{group.type}</td>
                  <td className="px-5 py-4">{group.canUseTopics ? `${group.topics?.length || 0} 个 Topic` : "不支持 Topic"}</td>
                </tr>
              )) : <tr><td className="px-5 py-6 font-bold text-ops-muted" colSpan={4}>暂无已配置群。</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="border-t border-ops-line px-5 py-3 text-sm font-bold text-ops-muted">{discoverStatus}</div>
      </Card>
      <section className="mb-5 grid gap-0 overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops md:grid-cols-4">
        <MetricBox label="已配置群" value={String(savedGroups.length)} sub="本地配置" />
        <MetricBox label="群类型" value="Forum" sub="支持 Topic 分区" />
        <MetricBox label="Topic 数量" value="7" sub="含代理专属 Topic" />
        <MetricBox label="配置状态" value="已启用" sub="新闻 / 信号 / 转发可绑定" />
      </section>
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-ops-line px-6 py-5 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h2 className="text-xl font-black">新增绑定规则</h2>
            <p className="mt-1 text-sm text-ops-muted">先选择投放位置，再选择配置包；机器人和频率会按配置自动带出。</p>
          </div>
          <button className="min-h-10 rounded-lg bg-ops-accent px-5 text-sm font-black text-white" onClick={saveBindingRule}>保存绑定规则</button>
        </div>
        <div className="grid gap-0 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_320px]">
          <div className="border-b border-ops-line p-6 xl:border-b-0 xl:border-r">
            <div className="mb-4 flex items-center justify-between gap-3"><h3 className="text-sm font-black text-ops-ink">目标位置</h3><span className="rounded-full bg-[#edf7f2] px-2 py-1 text-xs font-black text-ops-accent">{topicOptions.length || 0} 个 Topic</span></div>
            <div className="grid gap-4">
              <Field label="群"><select className={inputClass} value={bindingForm.group || dynamicGroupOptions[0] || ""} onChange={(event) => updateBindingForm({ group: event.target.value })}>{dynamicGroupOptions.map((group) => <option key={group}>{group}</option>)}</select></Field>
              <Field label="Topic"><select className={inputClass} disabled={!topicOptions.length} value={bindingForm.topic || topicOptions[0]?.name || ""} onChange={(event) => updateBindingForm({ topic: event.target.value })}>{topicOptions.length ? topicOptions.map((topic) => <option key={topic.name}>{topic.name}</option>) : <option>这个群还没有发现 Topic</option>}</select></Field>
            </div>
            <div className="mt-4 rounded-lg bg-[#fbfcfb] px-4 py-3 text-sm font-bold text-ops-muted">{topicOptions.length ? `当前群已加载 ${topicOptions.length} 个 Topic` : "当前群还没有 Topic 数据。"}</div>
          </div>
          <div className="border-b border-ops-line p-6 xl:border-b-0 xl:border-r">
            <div className="mb-4 flex items-center justify-between gap-3"><h3 className="text-sm font-black text-ops-ink">绑定配置</h3><span className="rounded-full bg-[#f5f7f6] px-2 py-1 text-xs font-black text-ops-muted">{configOptions.length} 个配置</span></div>
            <div className="grid gap-4">
              <Field label="类型"><select className={inputClass} value={bindingForm.type} onChange={(event) => updateBindingForm({ type: event.target.value })}>{Object.keys(configPools).map((type) => <option key={type}>{type}</option>)}</select></Field>
              <Field label="配置名称"><select className={inputClass} value={selectedConfig.name || ""} onChange={(event) => updateBindingForm({ config: event.target.value })}>{configOptions.map((config) => <option key={config.name}>{config.name}</option>)}</select></Field>
            </div>
          </div>
          <div className="p-6">
            <div className="mb-4 flex items-center justify-between gap-3"><h3 className="text-sm font-black text-ops-ink">执行信息</h3><span className="rounded-full bg-[#e6f7ef] px-2 py-1 text-xs font-black text-ops-accent">自动</span></div>
            <div className="grid gap-3">
              <Field label="机器人"><input className={`${inputClass} bg-[#f9fbfa] text-ops-ink`} readOnly value={selectedConfig.bot || ""} /></Field>
              <Field label="频率"><input className={`${inputClass} bg-[#f9fbfa] text-ops-ink`} readOnly value={selectedConfig.frequency || ""} /></Field>
            </div>
            <div className="mt-4 rounded-lg border border-ops-line bg-white px-4 py-3 text-sm leading-6 text-ops-muted"><strong className="text-ops-ink">{selectedConfig.name}</strong><div>{bindingForm.type} · {selectedConfig.bot} · {selectedConfig.frequency}</div><div className="break-words">{bindingForm.group} / {bindingForm.topic}</div></div>
          </div>
        </div>
      </Card>
      <Card className="mt-5 overflow-hidden">
        <div className="border-b border-ops-line p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h2 className="text-xl font-black">群绑定</h2>
            </div>
            <select className={`${inputClass} max-w-xs`} value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
              {["全部群", ...dynamicGroupOptions].map((group) => <option key={group}>{group}</option>)}
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted">
              <tr><th className="px-5 py-3">群</th><th className="px-5 py-3">TOPIC</th><th className="px-5 py-3">绑定配置</th><th className="px-5 py-3">机器人</th><th className="px-5 py-3">操作</th></tr>
            </thead>
            <tbody>
              {visibleGroupRoutes.map((route) => (
                <tr className="border-t border-ops-line align-top" key={route.id}>
                  <td className="px-5 py-4 font-bold">{route.group}</td>
                  <td className="px-5 py-4">{route.topic}</td>
                  <td className="px-5 py-4"><strong>{route.config}</strong><div className="mt-1 text-xs text-ops-muted">{route.type}{route.frequency ? ` · ${route.frequency}` : ""}</div></td>
                  <td className="px-5 py-4">{route.bot}</td>
                  <td className="px-5 py-4">
                    <div className="flex flex-wrap gap-2">
                      <button className="rounded-lg border border-ops-accent px-3 py-2 text-xs font-black text-ops-accent" onClick={() => testRoute(route.id)} type="button">测试</button>
                      <button className="rounded-lg border border-[#d85f5f] px-3 py-2 text-xs font-black text-[#b94141]" onClick={() => unlinkRoute(route.id)} type="button">解绑</button>
                    </div>
                  </td>
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
