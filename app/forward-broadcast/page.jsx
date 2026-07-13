"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ConsoleShell from "../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../components/ui";

const demoChatId = "-1003710405969";
const defaultRule = { name: "Demo Topic 全部消息广播", group: "YUBIT × Winkey Agent Community", chatId: demoChatId, topic: "test", topicId: null, listen: "全部消息", bot: "ForwardBot", frequency: "实时", status: "已启用" };

export default function ForwardBroadcastPage() {
  const [topics, setTopics] = useState([{ name: "test", threadId: null }]);
  const [groupName, setGroupName] = useState("YUBIT × Winkey Agent Community");
  const [rules, setRules] = useState([defaultRule]);
  const [form, setForm] = useState({ name: "Demo Topic 全部消息广播", topic: "test", bot: "ForwardBot" });
  const [status, setStatus] = useState("等待保存");

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("yubitBroadcastRules") || "[]");
      if (Array.isArray(saved) && saved.length) setRules(saved);
    } catch {}
    fetch("/api/group-config").then((response) => response.json()).then((data) => {
      const group = (data.groups || []).find((item) => String(item.chatId) === demoChatId) || (data.groups || []).find((item) => (item.title || "").includes("Winkey"));
      if (group?.title) setGroupName(group.title);
      if (group?.topics?.length) {
        setTopics(group.topics);
        setForm((current) => ({ ...current, topic: group.topics[0].name }));
      }
    }).catch(() => {});
  }, []);

  async function saveRule() {
    const topic = topics.find((item) => item.name === form.topic) || topics[0] || { name: form.topic };
    const name = form.name.trim() || `Demo ${topic.name} 全部消息广播`;
    const next = [{ name, group: groupName, chatId: demoChatId, topic: topic.name, topicId: topic.threadId || null, listen: "全部消息", bot: form.bot, frequency: "实时", status: "已启用" }, ...rules.filter((rule) => rule.name !== name)];
    setRules(next);
    localStorage.setItem("yubitBroadcastRules", JSON.stringify(next));
    await fetch("/api/broadcast-rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rules: next }) });
    setStatus("广播规则已保存，可到群配置里选择绑定。");
  }

  return (
    <ConsoleShell>
      <PageHeader title="广播转发" desc="监听 demo 群某个 Topic 的全部消息，保存为广播规则；目标群和 Topic 在群配置里绑定，绑定类型选择“广播”。" action={<Segment />} />
      <section className="mb-5 grid gap-0 overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops md:grid-cols-3">
        <MetricBox label="来源群" value="Demo 群" sub="Trader 发消息的测试群" />
        <MetricBox label="广播规则" value={rules.length} sub="保存后去群配置绑定目标" />
        <MetricBox label="转发机器人" value={rules[0]?.bot || "可配置"} sub="每条规则单独选择" />
      </section>
      <Card className="overflow-hidden">
        <div className="border-b border-ops-line px-6 py-5"><h2 className="text-xl font-black">新增广播规则</h2><p className="mt-1 text-sm text-ops-muted">这里只定义监听源；转发到哪些群和 Topic 统一到群配置里绑定。</p></div>
        <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Panel title="来源">
            <Field label="规则名称"><input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
            <Field label="Demo 群"><input className={`${inputClass} bg-[#f9fbfa]`} value={groupName} readOnly /></Field>
            <Field label="监听 Topic"><select className={inputClass} value={form.topic} onChange={(event) => setForm({ ...form, topic: event.target.value })}>{topics.map((topic) => <option key={topic.name}>{topic.name}</option>)}</select></Field>
            <div className="rounded-lg bg-[#fbfcfb] px-4 py-3 text-sm font-bold text-ops-muted">监听内容：全部消息。目标群和目标 Topic 请到「群配置」里绑定。</div>
          </Panel>
          <div className="p-6"><h3 className="mb-4 text-sm font-black">执行</h3><div className="grid gap-4"><Field label="转发模式"><input className={`${inputClass} bg-[#f9fbfa]`} value="复制发送" readOnly /></Field><Field label="转发机器人"><select className={inputClass} value={form.bot} onChange={(event) => setForm({ ...form, bot: event.target.value })}><option>ForwardBot</option><option>YUBITadmin</option><option>Trader1</option><option>MOD1</option><option>Jack</option><option>Tony</option></select></Field><Field label="状态"><select className={inputClass}><option>启用</option><option>暂停</option></select></Field></div><button className="mt-5 min-h-11 w-full rounded-lg bg-ops-accent px-5 text-sm font-black text-white" onClick={saveRule}>保存广播规则</button><div className="mt-3 text-sm font-bold text-ops-muted">{status}</div></div>
        </div>
      </Card>
      <RulesTable rules={rules} />
    </ConsoleShell>
  );
}

function Segment() { return <div className="flex rounded-lg border border-ops-line bg-white p-1 shadow-ops"><Link className="rounded-md bg-ops-accent px-4 py-2 text-sm font-black text-white" href="/forward-broadcast">广播</Link><Link className="rounded-md px-4 py-2 text-sm font-black text-ops-muted hover:bg-ops-soft" href="/forward-social">代理社媒</Link></div>; }
function Panel({ title, children }) { return <div className="border-b border-ops-line p-6 xl:border-b-0 xl:border-r"><h3 className="mb-4 text-sm font-black">{title}</h3><div className="grid gap-4">{children}</div></div>; }
function RulesTable({ rules }) { return <Card className="mt-5 overflow-hidden"><div className="border-b border-ops-line p-5"><h2 className="text-xl font-black">当前广播规则</h2><p className="mt-1 text-sm text-ops-muted">这些规则会作为“广播”配置出现在群配置绑定里。</p></div><div className="overflow-x-auto"><table className="w-full min-w-[980px] text-sm"><thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted"><tr><th className="px-5 py-3">配置名称</th><th className="px-5 py-3">来源群</th><th className="px-5 py-3">监听 Topic</th><th className="px-5 py-3">转发机器人</th><th className="px-5 py-3">状态</th></tr></thead><tbody>{rules.map((rule) => <tr className="border-t border-ops-line" key={rule.name}><td className="px-5 py-4 font-bold">{rule.name}</td><td className="px-5 py-4">{rule.group}<div className="mt-1 font-mono text-xs text-ops-muted">{rule.chatId}</div></td><td className="px-5 py-4">{rule.topic}{rule.topicId ? <div className="mt-1 font-mono text-xs text-ops-muted">thread {rule.topicId}</div> : null}</td><td className="px-5 py-4">{rule.bot || "YUBITadmin"}<div className="mt-1 text-xs text-ops-muted">{rule.listen || "全部消息"}</div></td><td className="px-5 py-4"><StatusPill>{rule.status || "已启用"}</StatusPill></td></tr>)}</tbody></table></div></Card>; }
function MetricBox({ label, value, sub }) { return <div className="border-b border-ops-line p-5 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0"><div className="text-sm font-bold text-ops-muted">{label}</div><div className="mt-1 text-2xl font-black">{value}</div><div className="mt-1 text-xs text-ops-muted">{sub}</div></div>; }
