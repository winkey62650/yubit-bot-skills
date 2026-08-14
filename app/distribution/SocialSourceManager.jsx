"use client";

import { useState } from "react";
import { buildSocialSourceReadiness, buildSocialSourceRouteReadiness } from "../../lib/distribution-ui.mjs";
import { formatDiscordTargetLabel } from "../../lib/discord-distribution-ui.mjs";
import { Card, Field, StatusPill, inputClass } from "../components/ui";

function createEmptySource() {
  return { id: "", name: "", agent: "", platform: "X", accountUrl: "", feedUrl: "", status: "已启用", targets: [] };
}

export default function SocialSourceManager({ packages, targetOptions = [], publisherName = "当前发布身份", busy, onPersist, onNotice }) {
  const [form, setForm] = useState(createEmptySource);
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState(null);
  const readiness = buildSocialSourceReadiness(packages);
  const routeReadiness = buildSocialSourceRouteReadiness(packages);
  const sourceValid = Boolean(form.name.trim() && form.agent.trim() && (form.accountUrl.trim() || form.feedUrl.trim()));
  const canSave = sourceValid && form.targets.length > 0;
  const groupedTargets = groupTargetOptions(targetOptions);
  const selectedTargetKeys = new Set(form.targets.map(socialTargetKey));

  async function saveSource() {
    if (!canSave) return;
    const source = { ...form, targets: form.targets.map((target) => ({ ...target })), id: form.id || `social-${Date.now()}` };
    const saved = await onPersist({ action: "upsert", source }, form.id ? "代理来源已更新。" : "代理来源已添加，并会每小时检查一次。");
    if (saved) {
      setForm(createEmptySource());
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
      onNotice("抓取测试通过；下面显示当前识别到的最新内容，不会发送到任何社区。");
    } catch (error) {
      onNotice(error.message);
    } finally {
      setTesting(false);
    }
  }

  async function persistMutation(mutation, message) {
    const saved = await onPersist(mutation, message);
    if (saved && mutation.action === "delete" && form.id === mutation.id) {
      setForm(createEmptySource());
      setPreview(null);
    }
  }

  function toggleTarget(target, checked) {
    const key = socialTargetKey(target);
    setForm((current) => ({
      ...current,
      targets: checked
        ? [...current.targets.filter((item) => socialTargetKey(item) !== key), { ...target }]
        : current.targets.filter((item) => socialTargetKey(item) !== key)
    }));
  }

  return <Card className="overflow-hidden">
    <div className="flex flex-col gap-3 border-b border-ops-line p-5 lg:flex-row lg:items-start lg:justify-between">
      <div><p className="text-xs font-black uppercase tracking-[.16em] text-ops-accent">代理内容来源</p><h2 className="mt-1 text-xl font-black">X / YouTube 自动抓取</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-ops-muted">后台抓取任务每小时检查一次，只在识别到新内容时共享。一个代理可以分别添加 X 和 YouTube 两条来源。</p></div>
      <div className="flex flex-wrap gap-2"><StatusPill tone={readiness.ready ? "green" : "amber"}>{readiness.enabled} 条启用</StatusPill><StatusPill tone={routeReadiness.ready ? "green" : "amber"}>{routeReadiness.mapped}/{routeReadiness.enabled} 条已绑定目标</StatusPill><StatusPill tone={readiness.limited ? "amber" : "green"}>{readiness.stable} 条稳定 · {readiness.limited} 条有限</StatusPill></div>
    </div>
    <div className="grid gap-5 p-5 xl:grid-cols-[minmax(320px,.82fr)_minmax(0,1.18fr)]">
      <div className="grid gap-3 rounded-lg border border-ops-line bg-[#fbfcfb] p-4">
        <h3 className="font-black">{form.id ? "编辑来源" : "新增来源"}</h3>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="来源名称"><input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：Ricky YouTube" /></Field><Field label="代理名称"><input className={inputClass} value={form.agent} onChange={(event) => setForm({ ...form, agent: event.target.value })} placeholder="例如：Ricky" /></Field></div>
        <Field label="平台"><select className={inputClass} value={form.platform} onChange={(event) => setForm({ ...form, platform: event.target.value })}><option value="X">X</option><option value="YouTube">YouTube</option></select></Field>
        <Field label="账号主页"><input className={inputClass} type="url" value={form.accountUrl} onChange={(event) => setForm({ ...form, accountUrl: event.target.value })} placeholder={form.platform === "YouTube" ? "https://www.youtube.com/@handle" : "https://x.com/username"} /></Field>
        <Field label="Feed 地址（可选）"><input className={inputClass} type="url" value={form.feedUrl} onChange={(event) => setForm({ ...form, feedUrl: event.target.value })} placeholder="RSS / Atom / JSON Feed" /></Field>
        <div className="grid gap-2">
          <div><p className="text-sm font-black">发送目标（Server / Channel 或群 / Topic）</p><p className="mt-1 text-xs leading-5 text-ops-muted">这条来源抓到新内容后，只会发送到下方选中的目标。社区默认折叠，展开后选择具体 Channel 或 Topic。</p></div>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-ops-line bg-white">
            {groupedTargets.length ? groupedTargets.map((group) => {
              const selectedCount = group.options.filter((option) => selectedTargetKeys.has(socialTargetKey(option.target))).length;
              return <details className="border-b border-ops-line last:border-b-0" key={group.groupKey} open={selectedCount > 0}>
                <summary className="cursor-pointer list-none px-3 py-3 text-sm font-black">{group.groupName}<span className="ml-2 text-xs font-bold text-ops-muted">{selectedCount}/{group.options.length} 已选</span></summary>
                <div className="grid gap-1 border-t border-ops-line bg-[#fbfcfb] p-2">{group.options.map((option) => <label className="flex min-h-10 items-center gap-3 rounded-md px-2 text-sm font-bold hover:bg-white" key={option.key}><input checked={selectedTargetKeys.has(socialTargetKey(option.target))} onChange={(event) => toggleTarget(option.target, event.target.checked)} type="checkbox" /><span>{targetChildLabel(option.target)}</span></label>)}</div>
              </details>;
            }) : <p className="p-4 text-sm font-bold text-ops-muted">暂无可发送目标，请先完成社区识别与授权。</p>}
          </div>
          {form.targets.length ? <div className="flex flex-wrap gap-2">{form.targets.map((target) => <span className="rounded-full bg-[#eaf6f0] px-3 py-1 text-xs font-black text-[#315b49]" key={socialTargetKey(target)}>{routeLabel(target)}</span>)}</div> : <p className="text-xs font-bold text-[#a04a3d]">必须至少选择一个发送目标。</p>}
        </div>
        <label className="flex min-h-10 items-center gap-3 text-sm font-bold"><input checked={form.status === "已启用"} onChange={(event) => setForm({ ...form, status: event.target.checked ? "已启用" : "已暂停" })} type="checkbox" />保存后立即启用</label>
        <div className="grid gap-2 sm:grid-cols-2"><button className="min-h-11 rounded-lg border border-ops-accent px-4 text-sm font-black text-ops-accent disabled:opacity-40" disabled={!sourceValid || testing || Boolean(busy)} onClick={testSource} type="button">{testing ? "正在抓取…" : "测试抓取"}</button><button className="min-h-11 rounded-lg bg-ops-accent px-4 text-sm font-black text-white disabled:opacity-40" disabled={!canSave || testing || Boolean(busy)} onClick={saveSource} type="button">保存来源</button></div>
        {form.id ? <button className="text-sm font-black text-ops-muted" onClick={() => { setForm(createEmptySource()); setPreview(null); }} type="button">取消编辑</button> : null}
        <p className="rounded-lg bg-[#f2faf6] p-3 text-xs leading-5 text-[#315b49]">YouTube 使用官方频道 Feed；X 会读取账号公开时间线并按推文编号去重。也可以填写自定义 Feed 覆盖默认抓取方式。</p>
        {preview ? <div className="rounded-lg border border-[#cae5da] bg-[#f2faf6] p-3 text-sm"><div className="flex items-center justify-between gap-2"><strong>最新内容预览</strong><StatusPill tone={preview.reliability === "limited" ? "amber" : "green"}>{preview.reliability === "stable" ? "官方来源" : preview.reliability === "standard" ? "公开时间线" : "有限检测"}</StatusPill></div><a className="mt-2 block break-words font-black text-ops-accent underline" href={preview.url} rel="noreferrer" target="_blank">{preview.title}</a>{preview.description ? <p className="mt-2 line-clamp-4 leading-6 text-[#41564d]">{preview.description}</p> : null}</div> : null}
      </div>
      <div className="overflow-hidden rounded-lg border border-ops-line">
        <div className="border-b border-ops-line bg-[#f9fbfa] px-4 py-3"><h3 className="font-black">已保存来源</h3><p className="mt-1 text-xs text-ops-muted">配置会保存在服务端，刷新、换设备和重新部署后仍然存在。</p></div>
        <div className="divide-y divide-ops-line">{packages.length ? packages.map((item) => {
          const sourceLabel = item.feedUrl ? "自定义 Feed" : item.platform === "YouTube" ? "官方 Feed" : item.platform === "X" ? "公开时间线" : "有限检测";
          const usable = sourceLabel !== "有限检测";
          const targets = Array.isArray(item.targets) ? item.targets : [];
          return <article className="p-4" key={item.id}><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong>{item.name}</strong><StatusPill tone={item.status === "已启用" ? "green" : "amber"}>{item.status}</StatusPill><StatusPill tone={usable ? "green" : "amber"}>{sourceLabel}</StatusPill><StatusPill tone={targets.length ? "green" : "amber"}>{targets.length ? `${targets.length} 个目标` : "未绑定目标"}</StatusPill></div><p className="mt-2 text-sm text-ops-muted">{item.agent} · {item.platform} · 每小时</p><p className="mt-1 truncate text-xs text-ops-muted">{item.feedUrl || item.accountUrl || "未填写地址"}</p><div className="mt-3 grid gap-1 text-xs font-bold text-[#41564d]">{targets.length ? targets.map((target) => <p key={socialTargetKey(target)}>{item.platform} @{item.agent} → {publisherName} → {routeLabel(target)}</p>) : <p className="text-[#a04a3d]">未设置发送目标，启用后也不会进入发送队列。</p>}</div></div><div className="flex shrink-0 flex-wrap gap-2"><SourceButton onClick={() => { setForm({ ...item, targets: targets.map((target) => ({ ...target })) }); setPreview(null); }}>编辑</SourceButton><SourceButton disabled={item.status !== "已启用" && !targets.length} onClick={() => persistMutation({ action: "set-status", id: item.id, status: item.status === "已启用" ? "已暂停" : "已启用" }, item.status === "已启用" ? "代理来源已暂停。" : "代理来源已启用。")}>{item.status === "已启用" ? "暂停" : "启用"}</SourceButton><SourceButton danger onClick={() => window.confirm("确认删除这条代理来源？") && persistMutation({ action: "delete", id: item.id }, "代理来源已删除。")}>删除</SourceButton></div></div></article>;
        }) : <div className="p-8 text-center text-sm font-bold text-ops-muted">之前的入口已恢复。现在还没有来源，请先在左侧添加代理的 X 或 YouTube。</div>}</div>
      </div>
    </div>
  </Card>;
}

function SourceButton({ children, danger = false, disabled = false, onClick }) {
  return <button className={`min-h-9 rounded-lg border px-3 text-xs font-black disabled:cursor-not-allowed disabled:opacity-40 ${danger ? "border-[#d85f5f] text-[#b94141]" : "border-ops-line text-[#33423b]"}`} disabled={disabled} onClick={onClick} type="button">{children}</button>;
}

function socialTargetKey(target) {
  if (target?.platform === "discord") return `discord:${target?.guildId || ""}:${target?.channelId || ""}`;
  return target?.chatType === "channel" ? `telegram:${target?.chatId || ""}:channel` : `telegram:${target?.chatId || ""}:${Number(target?.threadId || 0)}`;
}

function groupTargetOptions(options) {
  const groups = new Map();
  for (const option of options) {
    const isDiscord = option.target?.platform === "discord";
    const groupKey = isDiscord ? `discord:${option.target?.guildId || option.target?.groupName || "未命名服务器"}` : `telegram:${option.target?.chatId || option.target?.groupName || "未命名群"}`;
    const groupName = option.target?.groupName || (isDiscord ? option.target?.guildId : option.target?.chatId) || (isDiscord ? "未命名服务器" : "未命名群");
    if (!groups.has(groupKey)) groups.set(groupKey, { groupKey, groupName, options: [] });
    groups.get(groupKey).options.push(option);
  }
  return [...groups.values()];
}

function routeLabel(target) {
  if (target.platform === "discord") return formatDiscordTargetLabel(target);
  if (target.chatType === "channel") return target.groupName || target.chatId;
  return `${target.groupName || target.chatId} / ${target.topicName || `Topic ${target.threadId}`}`;
}

function targetChildLabel(target) {
  if (target.platform === "discord") return target.topicName || target.channelName || target.channelId;
  return target.topicName || (target.chatType === "channel" ? "频道" : `Topic ${target.threadId}`);
}
