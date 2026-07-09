"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../components/ui";

const emptyForm = {
  name: "",
  agent: "",
  platform: "Twitter / X",
  accountUrl: "",
  contentType: "全部新内容",
  frequency: "每 5 分钟",
  bot: "YUBITadmin",
  status: "启用"
};

export default function ForwardSocialPage() {
  const [packages, setPackages] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/social-packages")
      .then((response) => response.json())
      .then((data) => setPackages(data.packages || []))
      .catch((error) => setMessage(`读取失败：${error.message}`));
  }, []);

  async function save() {
    if (!form.name || !form.agent || !form.accountUrl) {
      setMessage("请填写包名称、代理名称和账号链接。");
      return;
    }
    setSaving(true);
    setMessage("正在保存社媒包...");
    const item = { ...form, status: form.status === "启用" ? "已启用" : "暂停" };
    try {
      const nextPackages = [item, ...packages.filter((pkg) => pkg.name !== item.name)];
      const response = await fetch("/api/social-packages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packages: nextPackages })
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || "保存失败");
      setPackages(data.packages || nextPackages);
      setForm(emptyForm);
      setMessage("已保存社媒包。");
    } catch (error) {
      setMessage(`保存失败：${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConsoleShell>
      <PageHeader title="代理社媒转发" desc="输入代理 Twitter / YouTube 链接，组合成代理社媒转发包；发到哪个群和 Topic 在群配置里绑定，绑定类型选择“代理社媒”。" action={<Segment />} />
      <section className="mb-5 grid gap-0 overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops md:grid-cols-3">
        <MetricBox label="监控账号" value={String(packages.length)} sub="Twitter / YouTube" />
        <MetricBox label="转发包" value="代理维度" sub="群配置里绑定 Topic" />
        <MetricBox label="检查频率" value="5 分钟" sub="可接后端任务" />
      </section>
      <Card className="overflow-hidden">
        <div className="border-b border-ops-line px-6 py-5"><h2 className="text-xl font-black">新增代理社媒包</h2><p className="mt-1 text-sm text-ops-muted">这里只定义代理社媒来源和监控规则；目标群和 Topic 统一到群配置里绑定。</p></div>
        <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Panel title="社媒包">
            <Field label="包名称"><input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ricky 社媒转发包" /></Field>
            <Field label="代理名称"><input className={inputClass} value={form.agent} onChange={(event) => setForm({ ...form, agent: event.target.value })} placeholder="Ricky / Jack / Tony" /></Field>
            <Field label="平台"><select className={inputClass} value={form.platform} onChange={(event) => setForm({ ...form, platform: event.target.value })}><option>Twitter / X</option><option>YouTube</option><option>Twitter / X + YouTube</option></select></Field>
            <Field label="账号链接"><input className={inputClass} value={form.accountUrl} onChange={(event) => setForm({ ...form, accountUrl: event.target.value })} placeholder="https://x.com/handle 或 YouTube Channel URL" /></Field>
            <Field label="内容类型"><select className={inputClass} value={form.contentType} onChange={(event) => setForm({ ...form, contentType: event.target.value })}><option>全部新内容</option><option>仅含关键词</option><option>排除转发 / Repost</option></select></Field>
          </Panel>
          <div className="p-6">
            <h3 className="mb-4 text-sm font-black">监控</h3>
            <div className="grid gap-4">
              <Field label="检查频率"><select className={inputClass} value={form.frequency} onChange={(event) => setForm({ ...form, frequency: event.target.value })}><option>每 5 分钟</option><option>每 15 分钟</option><option>每 30 分钟</option></select></Field>
              <Field label="转发机器人"><input className={`${inputClass} bg-[#f9fbfa]`} value={form.bot} readOnly /></Field>
              <Field label="状态"><select className={inputClass} value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option>启用</option><option>暂停</option></select></Field>
            </div>
            <button className="mt-5 min-h-11 w-full rounded-lg bg-ops-accent px-5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-60" disabled={saving} onClick={save}>{saving ? "保存中..." : "保存社媒包"}</button>
            {message && <div className="mt-3 rounded-lg bg-[#edf7f2] px-3 py-2 text-sm font-bold text-ops-accent">{message}</div>}
          </div>
        </div>
      </Card>
      <Card className="mt-5 overflow-hidden"><div className="border-b border-ops-line p-5"><h2 className="text-xl font-black">当前代理社媒包</h2><p className="mt-1 text-sm text-ops-muted">这些包会作为“代理社媒”配置出现在群配置绑定里。</p></div><div className="overflow-x-auto"><table className="w-full min-w-[940px] text-sm"><thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted"><tr><th className="px-5 py-3">包名称</th><th className="px-5 py-3">代理</th><th className="px-5 py-3">平台</th><th className="px-5 py-3">账号链接</th><th className="px-5 py-3">状态</th></tr></thead><tbody>{packages.map((item) => <tr className="border-t border-ops-line" key={item.id || item.name}><td className="px-5 py-4 font-bold">{item.name}</td><td className="px-5 py-4">{item.agent}</td><td className="px-5 py-4">{item.platform}</td><td className="px-5 py-4">{item.accountUrl || "待录入"}</td><td className="px-5 py-4"><StatusPill tone={item.status === "已启用" ? "green" : "amber"}>{item.status}</StatusPill></td></tr>)}</tbody></table></div></Card>
    </ConsoleShell>
  );
}

function Segment() { return <div className="flex rounded-lg border border-ops-line bg-white p-1 shadow-ops"><Link className="rounded-md px-4 py-2 text-sm font-black text-ops-muted hover:bg-ops-soft" href="/forward-broadcast">广播</Link><Link className="rounded-md bg-ops-accent px-4 py-2 text-sm font-black text-white" href="/forward-social">代理社媒</Link></div>; }
function Panel({ title, children }) { return <div className="border-b border-ops-line p-6 xl:border-b-0 xl:border-r"><h3 className="mb-4 text-sm font-black">{title}</h3><div className="grid gap-4">{children}</div></div>; }
function MetricBox({ label, value, sub }) { return <div className="border-b border-ops-line p-5 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0"><div className="text-sm font-bold text-ops-muted">{label}</div><div className="mt-1 text-2xl font-black">{value}</div><div className="mt-1 text-xs text-ops-muted">{sub}</div></div>; }
