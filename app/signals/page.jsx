"use client";

import { useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, PageHeader, StatusPill } from "../components/ui";

const strategies = [
  {
    name: "Futures SMA",
    scriptId: "futuresCard",
    source: "Binance Futures",
    format: "symbol / timeframe / SMA20 / SMA50 / direction / card text",
    status: "已启用"
  },
  {
    name: "TradFi SMA",
    scriptId: "tradfiCard",
    source: "TradFi market data",
    format: "asset / market / trend / macro note / card text",
    status: "已启用"
  }
];

export default function SignalsPage() {
  const [selected, setSelected] = useState(() => new Set(strategies.map((item) => item.name)));
  const [preview, setPreview] = useState({ state: "idle", message: "点击一个策略的“测试”，会发送测试卡片到 demo 群 test Topic。", log: "" });
  const enabled = strategies.filter((item) => selected.has(item.name));

  async function testSignal(strategy) {
    setPreview({ state: "running", message: `${strategy.name} · 正在发送到 demo 群 test Topic`, log: "正在读取数据源、生成卡片并准备测试 Topic。", strategy });
    const response = await fetch("/api/signal-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scriptId: strategy.scriptId })
    });
    const data = await response.json();
    setPreview({
      state: data.ok ? "success" : "error",
      message: `${strategy.name} · ${new Date().toLocaleString()}`,
      log: [data.ok ? "信号测试已发送。" : "执行失败。", data.stdout, data.stderr, data.error].filter(Boolean).join("\n\n"),
      strategy,
      testThreadId: data.testThreadId
    });
  }

  function toggleStrategy(name, checked) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  return (
    <ConsoleShell>
      <PageHeader title="信号配置" desc="维护信号策略池，测试每个策略的数据源、计算结果和输出格式；群和 Topic 的投放绑定在群配置里设置。" />
      <section className="mb-5 grid gap-0 overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops md:grid-cols-3">
        <MetricBox label="信号策略池" value={strategies.length} sub="Futures / TradFi" />
        <MetricBox label="可直接测试" value={strategies.length} sub="发送到 demo 群 test Topic" />
        <MetricBox label="群绑定位置" value="群配置" sub="勾选策略后，绑定到 Topic" />
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="overflow-hidden">
          <div className="border-b border-ops-line p-5">
            <h2 className="text-xl font-black">信号策略池</h2>
            <p className="mt-1 text-sm text-ops-muted">这里看策略包是否正常、输出什么结构；不会在这里配置发送目标。</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted">
                <tr><th className="px-5 py-3">启用</th><th className="px-5 py-3">信号策略</th><th className="px-5 py-3">数据源</th><th className="px-5 py-3">输出格式</th><th className="px-5 py-3">状态</th><th className="px-5 py-3">操作</th></tr>
              </thead>
              <tbody>
                {strategies.map((strategy) => (
                  <tr className="border-t border-ops-line align-top" key={strategy.name}>
                    <td className="px-5 py-4"><input className="h-4 w-4" type="checkbox" checked={selected.has(strategy.name)} onChange={(event) => toggleStrategy(strategy.name, event.target.checked)} /></td>
                    <td className="px-5 py-4"><strong>{strategy.name}</strong><div className="mt-1 text-xs text-ops-muted">{strategy.scriptId}</div></td>
                    <td className="px-5 py-4">{strategy.source}</td>
                    <td className="px-5 py-4 font-mono text-xs text-ops-muted">{strategy.format}</td>
                    <td className="px-5 py-4"><StatusPill>{strategy.status}</StatusPill></td>
                    <td className="px-5 py-4"><button className="rounded-lg border border-ops-accent px-3 py-2 text-xs font-black text-ops-accent" onClick={() => testSignal(strategy)}>测试</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-lg font-black">已启用信号包</h2>
          <p className="mt-1 text-sm text-ops-muted">这些名称会在群配置页面作为“信号配置”使用。</p>
          <div className="mt-4 grid gap-3 text-sm">
            {enabled.length ? enabled.map((strategy) => (
              <div className="rounded-lg bg-[#fbfcfb] px-3 py-3" key={strategy.name}><strong>{strategy.name}</strong><span className="mt-1 block text-xs text-ops-muted">{strategy.source}</span></div>
            )) : <div className="rounded-lg bg-[#fbfcfb] px-3 py-3 text-ops-muted">还没有启用信号策略。</div>}
          </div>
          <div className="mt-5 rounded-lg bg-[#fbfcfb] p-4 text-xs leading-5 text-ops-muted">下一步：到「群配置」里选择群和 Topic，再绑定这里勾选好的信号包。</div>
        </Card>
      </div>

      <Card className="mt-5 p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-black">策略测试结果</h2>
            <p className="mt-1 text-sm text-ops-muted">{preview.message}</p>
          </div>
          <StatusPill tone={preview.state === "error" ? "amber" : "green"}>{stateLabel(preview.state)}</StatusPill>
        </div>
        <div className="mt-4 grid gap-3">
          {preview.strategy && (
            <>
              <div className="rounded-lg border border-ops-line bg-[#edf7f2] p-4 text-sm text-ops-accent"><strong>测试目标</strong><div className="mt-2 text-xs text-ops-muted">Demo 群 -1003710405969 · test Topic #{preview.testThreadId}</div></div>
              <div className="rounded-lg border border-ops-line bg-[#fbfcfb] p-4 text-sm"><strong>返回格式</strong><div className="mt-2 font-mono text-xs text-ops-muted">{preview.strategy.format}</div></div>
            </>
          )}
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#101815] p-4 text-xs leading-5 text-[#d8f9e7]">{preview.log || "信号测试会发送到 demo 群 test Topic，不会发到正式群。"}</pre>
        </div>
      </Card>
    </ConsoleShell>
  );
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
