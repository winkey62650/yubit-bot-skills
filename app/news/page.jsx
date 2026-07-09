"use client";

import { useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, PageHeader, StatusPill, inputClass } from "../components/ui";
import { cryptoNewsSources, recommendedCryptoNewsSources } from "../../crypto-news-sources.mjs";

export default function NewsPage() {
  const [sourceFilter, setSourceFilter] = useState("全部");
  const [selected, setSelected] = useState(() => new Set(recommendedCryptoNewsSources.filter((source) => !source.status.includes("Key")).map((source) => source.name)));
  const [preview, setPreview] = useState({ state: "idle", message: "选择一个新闻源后，会发送测试消息到 demo 群 test Topic。", source: null, items: [] });
  const visibleSources = cryptoNewsSources.filter((source) => sourceFilter === "全部" || source.kind.includes(sourceFilter));
  const enabledSources = cryptoNewsSources.filter((source) => selected.has(source.name));

  async function testSource(sourceName) {
    setPreview({ state: "running", message: `${sourceName} · 正在抓取并发送到 demo 群 test Topic`, source: null, items: [] });
    const response = await fetch("/api/news-source-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceName, limit: 5 })
    });
    const data = await response.json();
    setPreview({
      state: data.ok ? "success" : "error",
      message: data.ok ? `${sourceName} · ${new Date(data.fetchedAt).toLocaleString()}` : `${sourceName} · 需处理`,
      source: data.source,
      format: data.format,
      items: data.items || [],
      error: data.error,
      testThreadId: data.testThreadId
    });
  }

  function toggleSource(name, checked) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  return (
    <ConsoleShell>
      <PageHeader title="新闻配置" desc="维护新闻源池，测试每个来源是否正常、返回什么格式；群和 Topic 的投放绑定在群配置里设置。" />
      <section className="mb-5 grid gap-0 overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops md:grid-cols-3">
        <MetricBox label="新闻源池" value={cryptoNewsSources.length} sub="RSS / API / 聚合源" />
        <MetricBox label="可直接测试" value={cryptoNewsSources.filter(canPreview).length} sub="公开 RSS 或无 key 源" />
        <MetricBox label="群绑定位置" value="群配置" sub="勾选源后，绑定到 Topic" />
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-4 border-b border-ops-line p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-black">加密新闻源池</h2>
              <p className="mt-1 text-sm text-ops-muted">勾选代表纳入新闻包；点击测试会抓取样本并发送到 demo 群 test Topic。</p>
            </div>
            <select className={`${inputClass} w-full md:w-40`} value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
              <option>全部</option>
              <option>RSS</option>
              <option>API</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1060px] text-sm">
              <thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted">
                <tr><th className="px-5 py-3">启用</th><th className="px-5 py-3">新闻源</th><th className="px-5 py-3">类型</th><th className="px-5 py-3">权限</th><th className="px-5 py-3">覆盖范围</th><th className="px-5 py-3">状态</th><th className="px-5 py-3">操作</th></tr>
              </thead>
              <tbody>
                {visibleSources.map((source) => (
                  <tr className="border-t border-ops-line align-top" key={source.name}>
                    <td className="px-5 py-4"><input className="h-4 w-4" type="checkbox" checked={selected.has(source.name)} onChange={(event) => toggleSource(source.name, event.target.checked)} /></td>
                    <td className="px-5 py-4"><strong>{source.name}</strong><div className="mt-1 max-w-sm break-all font-mono text-xs text-ops-muted">{source.endpoint}</div></td>
                    <td className="px-5 py-4">{source.kind}</td>
                    <td className="px-5 py-4">{source.access}</td>
                    <td className="px-5 py-4">{source.coverage}<div className="mt-1 text-xs text-ops-muted">{source.note}</div></td>
                    <td className="px-5 py-4"><StatusPill tone={source.status.includes("Key") ? "amber" : "green"}>{source.status}</StatusPill></td>
                    <td className="px-5 py-4"><button className="rounded-lg border border-ops-accent px-3 py-2 text-xs font-black text-ops-accent" onClick={() => testSource(source.name)}>测试</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-lg font-black">已启用新闻包</h2>
          <p className="mt-1 text-sm text-ops-muted">这些名称会在群配置页面作为“新闻配置”使用。</p>
          <div className="mt-4 grid gap-3 text-sm">
            {enabledSources.length ? enabledSources.map((source) => (
              <div className="rounded-lg bg-[#fbfcfb] px-3 py-3" key={source.name}><strong>{source.name}</strong><span className="mt-1 block text-xs text-ops-muted">{source.kind} · {source.access}</span></div>
            )) : <div className="rounded-lg bg-[#fbfcfb] px-3 py-3 text-ops-muted">还没有启用新闻源。</div>}
          </div>
          <div className="mt-5 rounded-lg bg-[#fbfcfb] p-4 text-xs leading-5 text-ops-muted">下一步：到「群配置」里选择群和 Topic，再绑定这里勾选好的新闻包。</div>
        </Card>
      </div>

      <Card className="mt-5 p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-black">源测试结果</h2>
            <p className="mt-1 text-sm text-ops-muted">{preview.message}</p>
          </div>
          <StatusPill tone={preview.state === "error" ? "amber" : "green"}>{stateLabel(preview.state)}</StatusPill>
        </div>
        <div className={preview.state === "success" ? "mt-4 grid gap-3" : preview.state === "error" ? "mt-4 rounded-lg bg-[#fff4df] p-4 text-sm leading-6 text-[#8a5a13]" : "mt-4 rounded-lg bg-[#fbfcfb] p-4 text-sm leading-6 text-ops-muted"}>
          {preview.state === "idle" ? "点击 Cointelegraph RSS 或其他来源的“测试”。" : preview.state === "running" ? "正在连接新闻源并准备测试 Topic，请稍等。" : preview.state === "error" ? (preview.error || "这个来源暂时不能测试。API 源需要先配置 key 或接适配器。") : (
            <>
              <div className="rounded-lg border border-ops-line bg-[#edf7f2] p-4 text-sm text-ops-accent"><strong>测试目标</strong><div className="mt-2 text-xs text-ops-muted">Demo 群 -1003710405969 · test Topic #{preview.testThreadId}</div></div>
              <div className="rounded-lg border border-ops-line bg-[#fbfcfb] p-4 text-sm"><strong>返回格式</strong><div className="mt-2 font-mono text-xs text-ops-muted">{preview.format}</div></div>
              {preview.items.map((item) => (
                <article className="rounded-lg border border-ops-line bg-white p-4" key={item.link || item.title}>
                  <div className="text-xs font-black text-ops-accent">{item.pubDate || preview.source?.name}</div>
                  <h3 className="mt-2 font-black">{item.title}</h3>
                  <p className="mt-2 whitespace-pre-line text-sm leading-6 text-ops-muted">{item.aiBrief || item.description}</p>
                  {item.link && <a className="mt-2 block break-all text-xs font-bold text-ops-muted hover:text-ops-accent" href={item.link} rel="noreferrer" target="_blank">{item.link}</a>}
                </article>
              ))}
            </>
          )}
        </div>
      </Card>
    </ConsoleShell>
  );
}

function canPreview(source) {
  return source.kind.includes("RSS") && !source.endpoint.includes("$") && /^https?:\/\//.test(source.endpoint);
}

function stateLabel(state) {
  return {
    idle: "待测试",
    running: "测试中",
    success: "已发送",
    error: "需处理"
  }[state] || "待检查";
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
