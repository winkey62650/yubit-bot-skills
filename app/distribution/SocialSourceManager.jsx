"use client";

import { useState } from "react";
import { buildSocialSourceReadiness } from "../../lib/distribution-ui.mjs";
import { Card, Field, StatusPill, inputClass } from "../components/ui";

const emptySource = { id: "", name: "", agent: "", platform: "X", accountUrl: "", feedUrl: "", status: "已启用" };

export default function SocialSourceManager({ packages, busy, onPersist, onNotice }) {
  const [form, setForm] = useState(emptySource);
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState(null);
  const readiness = buildSocialSourceReadiness(packages);
  const canSave = Boolean(form.name.trim() && form.agent.trim() && (form.accountUrl.trim() || form.feedUrl.trim()));

  async function saveSource() {
    if (!canSave) return;
    const source = { ...form, id: form.id || `social-${Date.now()}` };
    const next = form.id ? packages.map((item) => item.id === form.id ? source : item) : [...packages, source];
    const saved = await onPersist(next, form.id ? "代理来源已更新。" : "代理来源已添加，并会每 4 小时检查一次。");
    if (saved) {
      setForm(emptySource);
      setPreview(null);
    }
  }

  async function testSource() {
    setTesting(true);
    setPreview(null);
    onNotice("");
    try {
      const response = await fetch("/api/social-packages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test", source: form })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "抓取测试失败");
      setPreview(result.preview);
      onNotice("抓取测试通过；下面显示当前识别到的最新内容，不会发送到 Telegram。");
    } catch (error) {
      onNotice(error.message);
    } finally {
      setTesting(false);
    }
  }

  async function updatePackages(next, message) {
    const saved = await onPersist(next, message);
    if (saved && form.id && !next.some((item) => item.id === form.id)) {
      setForm(emptySource);
      setPreview(null);
    }
  }

  return <Card className="overflow-hidden">
    <div className="flex flex-col gap-3 border-b border-ops-line p-5 lg:flex-row lg:items-start lg:justify-between">
      <div><p className="text-xs font-black uppercase tracking-[.16em] text-ops-accent">代理内容来源</p><h2 className="mt-1 text-xl font-black">X / YouTube 自动抓取</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-ops-muted">SpeakerBot 每 4 小时检查一次，只在识别到新内容时共享。一个代理可以分别添加 X 和 YouTube 两条来源。</p></div>
      <div className="flex flex-wrap gap-2"><StatusPill tone={readiness.ready ? "green" : "amber"}>{readiness.enabled} 条启用</StatusPill><StatusPill tone={readiness.limited ? "amber" : "green"}>{readiness.stable} 条稳定 · {readiness.limited} 条有限</StatusPill></div>
    </div>
    <div className="grid gap-5 p-5 xl:grid-cols-[minmax(320px,.82fr)_minmax(0,1.18fr)]">
      <div className="grid gap-3 rounded-lg border border-ops-line bg-[#fbfcfb] p-4">
        <h3 className="font-black">{form.id ? "编辑来源" : "新增来源"}</h3>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="来源名称"><input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：Ricky YouTube" /></Field><Field label="代理名称"><input className={inputClass} value={form.agent} onChange={(event) => setForm({ ...form, agent: event.target.value })} placeholder="例如：Ricky" /></Field></div>
        <Field label="平台"><select className={inputClass} value={form.platform} onChange={(event) => setForm({ ...form, platform: event.target.value })}><option value="X">X</option><option value="YouTube">YouTube</option></select></Field>
        <Field label="账号主页"><input className={inputClass} type="url" value={form.accountUrl} onChange={(event) => setForm({ ...form, accountUrl: event.target.value })} placeholder={form.platform === "YouTube" ? "https://www.youtube.com/@handle" : "https://x.com/username"} /></Field>
        <Field label="Feed 地址（可选）"><input className={inputClass} type="url" value={form.feedUrl} onChange={(event) => setForm({ ...form, feedUrl: event.target.value })} placeholder="RSS / Atom / JSON Feed" /></Field>
        <label className="flex min-h-10 items-center gap-3 text-sm font-bold"><input checked={form.status === "已启用"} onChange={(event) => setForm({ ...form, status: event.target.checked ? "已启用" : "已暂停" })} type="checkbox" />保存后立即启用</label>
        <div className="grid gap-2 sm:grid-cols-2"><button className="min-h-11 rounded-lg border border-ops-accent px-4 text-sm font-black text-ops-accent disabled:opacity-40" disabled={!canSave || testing || Boolean(busy)} onClick={testSource} type="button">{testing ? "正在抓取…" : "测试抓取"}</button><button className="min-h-11 rounded-lg bg-ops-accent px-4 text-sm font-black text-white disabled:opacity-40" disabled={!canSave || testing || Boolean(busy)} onClick={saveSource} type="button">保存来源</button></div>
        {form.id ? <button className="text-sm font-black text-ops-muted" onClick={() => { setForm(emptySource); setPreview(null); }} type="button">取消编辑</button> : null}
        <p className="rounded-lg bg-[#fff8e8] p-3 text-xs leading-5 text-[#79591e]">YouTube 会解析官方频道 Feed。X 稳定抓取需要服务端 X API 凭证或单独填写 Feed；否则只能进行有限的主页变化检测。</p>
        {preview ? <div className="rounded-lg border border-[#cae5da] bg-[#f2faf6] p-3 text-sm"><div className="flex items-center justify-between gap-2"><strong>最新内容预览</strong><StatusPill tone={preview.reliability === "limited" ? "amber" : "green"}>{preview.reliability === "limited" ? "有限检测" : "稳定来源"}</StatusPill></div><a className="mt-2 block break-words font-black text-ops-accent underline" href={preview.url} rel="noreferrer" target="_blank">{preview.title}</a>{preview.description ? <p className="mt-2 line-clamp-4 leading-6 text-[#41564d]">{preview.description}</p> : null}</div> : null}
      </div>
      <div className="overflow-hidden rounded-lg border border-ops-line">
        <div className="border-b border-ops-line bg-[#f9fbfa] px-4 py-3"><h3 className="font-black">已保存来源</h3><p className="mt-1 text-xs text-ops-muted">配置会保存在服务端，刷新、换设备和重新部署后仍然存在。</p></div>
        <div className="divide-y divide-ops-line">{packages.length ? packages.map((item) => {
          const stable = Boolean(item.feedUrl) || item.platform === "YouTube";
          return <article className="p-4" key={item.id}><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong>{item.name}</strong><StatusPill tone={item.status === "已启用" ? "green" : "amber"}>{item.status}</StatusPill><StatusPill tone={stable ? "green" : "amber"}>{stable ? "稳定抓取" : "有限检测"}</StatusPill></div><p className="mt-2 text-sm text-ops-muted">{item.agent} · {item.platform} · 每 4 小时</p><p className="mt-1 truncate text-xs text-ops-muted">{item.feedUrl || item.accountUrl || "未填写地址"}</p></div><div className="flex shrink-0 flex-wrap gap-2"><SourceButton onClick={() => { setForm(item); setPreview(null); }}>编辑</SourceButton><SourceButton onClick={() => updatePackages(packages.map((source) => source.id === item.id ? { ...source, status: source.status === "已启用" ? "已暂停" : "已启用" } : source), item.status === "已启用" ? "代理来源已暂停。" : "代理来源已启用。")}>{item.status === "已启用" ? "暂停" : "启用"}</SourceButton><SourceButton danger onClick={() => window.confirm("确认删除这条代理来源？") && updatePackages(packages.filter((source) => source.id !== item.id), "代理来源已删除。")}>删除</SourceButton></div></div></article>;
        }) : <div className="p-8 text-center text-sm font-bold text-ops-muted">之前的入口已恢复。现在还没有来源，请先在左侧添加代理的 X 或 YouTube。</div>}</div>
      </div>
    </div>
  </Card>;
}

function SourceButton({ children, danger = false, onClick }) {
  return <button className={`min-h-9 rounded-lg border px-3 text-xs font-black ${danger ? "border-[#d85f5f] text-[#b94141]" : "border-ops-line text-[#33423b]"}`} onClick={onClick} type="button">{children}</button>;
}
