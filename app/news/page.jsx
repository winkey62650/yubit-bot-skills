"use client";

import { useEffect, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, PageHeader, StatusPill, inputClass } from "../components/ui";
import { cryptoNewsSources, recommendedCryptoNewsSources } from "../../crypto-news-sources.mjs";
import { smartMoneySources } from "../../smart-money-sources.mjs";

export default function NewsPage() {
  const [activeNewsTab, setActiveNewsTab] = useState("sources");
  const [sourceFilter, setSourceFilter] = useState("全部");
  const [sourcePage, setSourcePage] = useState(1);
  const [selected, setSelected] = useState(() => new Set(recommendedCryptoNewsSources.filter(canPreview).map((source) => source.name)));
  const [preview, setPreview] = useState({ state: "idle", message: "选择一个新闻源后，会发送测试消息到 demo 群 test Topic。", source: null, items: [] });
  const [dailyReport, setDailyReport] = useState({ reportTime: "08:30", timezone: "Asia/Shanghai", bot: "Trader1", body: "" });
  const [dailyStatus, setDailyStatus] = useState("日报配置待加载。");
  const [chartAnalysis, setChartAnalysis] = useState({
    reportTime: "09:00",
    timezone: "Asia/Shanghai",
    bot: "Trader1",
    symbols: ["BTCUSDT", "ETHUSDT"],
    chartInterval: "1h",
    stockUniverse: "SPY, QQQ, DIA, IWM, TLT, GLD, USO, UUP",
    body: ""
  });
  const [chartStatus, setChartStatus] = useState("看图分析配置待加载。");
  const [marketEvent, setMarketEvent] = useState({ chatId: "-1004331355892", threadId: "169", imagePath: "assets/market-events/market-event-cover.jpg", prompt: defaultMarketEventPrompt });
  const [marketEventOutput, setMarketEventOutput] = useState("");
  const [marketEventStatus, setMarketEventStatus] = useState("Market Events AI 配置待加载。");
  const visibleSources = cryptoNewsSources.filter((source) => sourceFilter === "全部" || source.kind.includes(sourceFilter));
  const enabledSources = cryptoNewsSources.filter((source) => selected.has(source.name));
  const sourcePageSize = 6;
  const totalSourcePages = Math.max(1, Math.ceil(visibleSources.length / sourcePageSize));
  const safeSourcePage = Math.min(sourcePage, totalSourcePages);
  const sourceStart = (safeSourcePage - 1) * sourcePageSize;
  const pagedSources = visibleSources.slice(sourceStart, sourceStart + sourcePageSize);

  useEffect(() => {
    loadDailyReport();
    loadChartAnalysis();
    loadMarketEvent();
  }, []);

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

  async function testSmartMoney() {
    setPreview({ state: "running", message: "Smart Money Tracker · 正在发送到 demo 群 test Topic", source: null, items: [] });
    const response = await fetch("/api/smart-money-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sendTelegram: true })
    });
    const data = await response.json();
    setPreview({
      state: data.ok ? "success" : "error",
      message: data.ok ? "Smart Money Tracker · 已发送到 demo 群 test Topic" : "Smart Money Tracker · 测试失败",
      source: { name: "Smart Money Tracker" },
      format: "Telegram HTML text: order-book walls / liquidations / ETF flow status / missing professional keys",
      items: data.ok ? [{ title: "Smart Money Tracker output", aiBrief: data.stdout || "已发送。" }] : [],
      error: data.stderr || data.error,
      testThreadId: data.testThreadId
    });
  }

  async function loadDailyReport() {
    try {
      const response = await fetch("/api/daily-report-config");
      const data = await response.json();
      if (data.config) setDailyReport(data.config);
      setDailyStatus("日报配置已加载。");
    } catch (error) {
      setDailyStatus(`日报配置读取失败：${error.message}`);
    }
  }

  async function loadChartAnalysis() {
    try {
      const response = await fetch("/api/daily-chart-analysis-config");
      const data = await response.json();
      if (data.config) setChartAnalysis(data.config);
      setChartStatus("看图分析配置已加载。");
    } catch (error) {
      setChartStatus(`看图分析配置读取失败：${error.message}`);
    }
  }

  async function loadMarketEvent() {
    try {
      const response = await fetch("/api/market-event-config");
      const data = await response.json();
      if (data.config) setMarketEvent((current) => ({ ...current, ...data.config }));
      setMarketEventStatus("Market Events AI 配置已加载。");
    } catch (error) {
      setMarketEventStatus(`Market Events AI 配置读取失败：${error.message}`);
    }
  }

  async function saveMarketEvent() {
    setMarketEventStatus("正在保存 Market Events AI 配置...");
    const response = await fetch("/api/market-event-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: marketEvent })
    });
    const data = await response.json();
    if (data.config) setMarketEvent((current) => ({ ...current, ...data.config }));
    setMarketEventStatus(data.ok ? "Market Events AI 提示词已保存。" : data.error || "Market Events AI 保存失败。");
    return data;
  }

  async function publishMarketEvent() {
    let draft;
    try {
      draft = JSON.parse(marketEventOutput);
    } catch (error) {
      setMarketEventStatus(`AI 输出不是有效 JSON：${error.message}`);
      return;
    }
    if (!draft.title || !Array.isArray(draft.highlights) || draft.highlights.length !== 3) {
      setMarketEventStatus("AI 输出必须包含 title 和恰好 3 条 highlights。");
      return;
    }
    if (!window.confirm(`确认发布到 Market Events Topic（#${marketEvent.threadId}）吗？`)) return;
    setMarketEventStatus("正在发布到 Market Events...");
    const response = await fetch("/api/scripts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scriptId: "marketEvent", payload: { mode: "production", chatId: marketEvent.chatId, threadId: marketEvent.threadId, marketEventTitle: draft.title, marketEventItems: draft.highlights, marketEventImage: marketEvent.imagePath } })
    });
    const data = await response.json();
    if (!data.ok) {
      setMarketEventStatus(data.error || data.stderr || "Market Events 发布失败。");
      return;
    }
    try {
      const output = JSON.parse(data.stdout || "{}");
      setMarketEventStatus(`已发布到 Telegram，消息编号 ${output.messageId || "已返回"}。`);
    } catch {
      setMarketEventStatus("Market Events 已发布。");
    }
  }

  function dailyPayload() {
    return {
      name: "Daily Morning Brief",
      kind: "daily-report",
      reportTime: dailyReport.reportTime || "08:30",
      timezone: dailyReport.timezone || "Asia/Shanghai",
      bot: dailyReport.bot || "Trader1",
      frequency: `每日 ${dailyReport.reportTime || "08:30"}`,
      status: "已启用",
      body: dailyReport.body || ""
    };
  }

  async function saveDailyReport() {
    setDailyStatus("正在保存日报配置...");
    const response = await fetch("/api/daily-report-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dailyPayload())
    });
    const data = await response.json();
    if (data.config) setDailyReport(data.config);
    setDailyStatus(data.ok ? "日报配置已保存。" : data.error || "日报配置保存失败。");
    return data;
  }

  async function testDailyReport() {
    await saveDailyReport();
    setPreview({ state: "running", message: "Daily Morning Brief · 正在发送到 demo 群 test Topic", source: null, items: [] });
    const response = await fetch("/api/daily-report-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: dailyPayload(), sendTelegram: true })
    });
    const data = await response.json();
    setPreview({
      state: data.ok ? "success" : "error",
      message: data.ok ? "Daily Morning Brief · 已发送到 demo 群 test Topic" : "Daily Morning Brief · 测试失败",
      source: { name: "Daily Morning Brief" },
      format: "Telegram HTML text: daily morning highlight list",
      items: data.ok ? [{ title: "Daily Morning Brief output", aiBrief: data.stdout || "已发送。" }] : [],
      error: data.stderr || data.error,
      testThreadId: data.testThreadId
    });
  }

  function chartPayload() {
    return {
      name: "Daily Chart Analysis",
      kind: "daily-chart-analysis",
      reportTime: chartAnalysis.reportTime || "09:00",
      timezone: chartAnalysis.timezone || "Asia/Shanghai",
      bot: chartAnalysis.bot || "Trader1",
      frequency: `每日 ${chartAnalysis.reportTime || "09:00"}`,
      status: "已启用",
      symbols: Array.isArray(chartAnalysis.symbols) ? chartAnalysis.symbols : symbolsFromText(chartAnalysis.symbols),
      chartInterval: chartAnalysis.chartInterval || "1h",
      stockUniverse: chartAnalysis.stockUniverse || "SPY, QQQ, DIA, IWM, TLT, GLD, USO, UUP",
      body: chartAnalysis.body || ""
    };
  }

  async function saveChartAnalysis() {
    setChartStatus("正在保存看图分析配置...");
    const response = await fetch("/api/daily-chart-analysis-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chartPayload())
    });
    const data = await response.json();
    if (data.config) setChartAnalysis(data.config);
    setChartStatus(data.ok ? "看图分析配置已保存。" : data.error || "看图分析配置保存失败。");
    return data;
  }

  async function testChartAnalysis() {
    await saveChartAnalysis();
    setPreview({ state: "running", message: "Daily Chart Analysis · 正在发送 BTC/ETH 和美股图卡到 demo 群 test Topic", source: null, items: [] });
    const response = await fetch("/api/daily-chart-analysis-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: chartPayload(), sendTelegram: true })
    });
    const data = await response.json();
    setPreview({
      state: data.ok ? "success" : "error",
      message: data.ok ? "Daily Chart Analysis · 已发送到 demo 群 test Topic" : "Daily Chart Analysis · 测试失败",
      source: { name: "Daily Chart Analysis" },
      format: "Telegram image cards: BTC/ETH futures SMA chart card + US stocks TradFi SMA chart card",
      items: data.ok ? [{ title: "Daily Chart Analysis output", aiBrief: data.stdout || "已发送图卡。" }] : [],
      error: data.stderr || data.error,
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
      <div className="mb-5 flex gap-2 border-b border-ops-line">
        <button className={`border-b-2 px-4 py-3 text-sm font-black ${activeNewsTab === "sources" ? "border-ops-accent text-ops-accent" : "border-transparent text-ops-muted"}`} onClick={() => setActiveNewsTab("sources")}>新闻源</button>
        <button className={`border-b-2 px-4 py-3 text-sm font-black ${activeNewsTab === "daily" ? "border-ops-accent text-ops-accent" : "border-transparent text-ops-muted"}`} onClick={() => setActiveNewsTab("daily")}>日报</button>
      </div>
      {activeNewsTab === "sources" && <>
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
            <select className={`${inputClass} w-full md:w-40`} value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value); setSourcePage(1); }}>
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
                {pagedSources.map((source) => (
                  <tr className="border-t border-ops-line align-top" key={source.name}>
                    <td className="px-5 py-4"><input className="h-4 w-4" type="checkbox" checked={selected.has(source.name)} onChange={(event) => toggleSource(source.name, event.target.checked)} /></td>
                    <td className="px-5 py-4"><strong>{source.name}</strong><div className="mt-1 max-w-sm break-all font-mono text-xs text-ops-muted">{source.endpoint}</div></td>
                    <td className="px-5 py-4">{source.kind}</td>
                    <td className="px-5 py-4">{source.access}</td>
                    <td className="px-5 py-4">{source.coverage}<div className="mt-1 text-xs text-ops-muted">{source.note}</div></td>
                    <td className="px-5 py-4"><StatusPill tone={source.status.includes("Key") ? "amber" : "green"}>{source.status}</StatusPill></td>
                    <td className="px-5 py-4">
                      <button
                        className={`rounded-lg border border-ops-accent px-3 py-2 text-xs font-black text-ops-accent ${canPreview(source) ? "" : "cursor-not-allowed opacity-50"}`}
                        disabled={!canPreview(source)}
                        onClick={() => testSource(source.name)}
                      >
                        测试
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-3 border-t border-ops-line px-5 py-4 text-sm text-ops-muted md:flex-row md:items-center md:justify-between">
            <div>{visibleSources.length ? `显示 ${sourceStart + 1}-${sourceStart + pagedSources.length} / ${visibleSources.length} 个新闻源` : "没有匹配的新闻源"}</div>
            <div className="flex items-center gap-2">
              <button className="rounded-lg border border-ops-line px-3 py-2 text-xs font-black text-ops-muted disabled:cursor-not-allowed disabled:opacity-40" disabled={safeSourcePage <= 1} onClick={() => setSourcePage((page) => Math.max(1, page - 1))}>上一页</button>
              <div className="flex items-center gap-1">
                {Array.from({ length: totalSourcePages }, (_, index) => index + 1).map((page) => (
                  <button className={`h-8 min-w-8 rounded-lg px-2 text-xs font-black ${page === safeSourcePage ? "bg-ops-accent text-white" : "border border-ops-line text-ops-muted"}`} key={page} onClick={() => setSourcePage(page)}>{page}</button>
                ))}
              </div>
              <button className="rounded-lg border border-ops-line px-3 py-2 text-xs font-black text-ops-muted disabled:cursor-not-allowed disabled:opacity-40" disabled={safeSourcePage >= totalSourcePages} onClick={() => setSourcePage((page) => Math.min(totalSourcePages, page + 1))}>下一页</button>
            </div>
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

      </>}

      {activeNewsTab === "daily" && <>
      <Card className="mt-5 overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-ops-line p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-black">每日早间热点</h2>
            <p className="mt-1 text-sm text-ops-muted">配置 Daily Morning Brief。到点后会发送到群配置里绑定了这个新闻配置的 Topic。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="rounded-lg border border-ops-accent px-4 py-2 text-sm font-black text-ops-accent" onClick={saveDailyReport}>保存日报</button>
            <button className="rounded-lg bg-ops-accent px-4 py-2 text-sm font-black text-white" onClick={testDailyReport}>测试发送</button>
          </div>
        </div>
        <div className="grid gap-0 lg:grid-cols-[280px_220px_220px_minmax(0,1fr)]">
          <label className="grid gap-2 border-b border-ops-line p-5 text-sm font-bold text-ops-muted lg:border-b-0 lg:border-r">发送时间
            <input className={inputClass} type="time" value={dailyReport.reportTime || "08:30"} onChange={(event) => setDailyReport((current) => ({ ...current, reportTime: event.target.value }))} />
          </label>
          <label className="grid gap-2 border-b border-ops-line p-5 text-sm font-bold text-ops-muted lg:border-b-0 lg:border-r">时区
            <select className={inputClass} value={dailyReport.timezone || "Asia/Shanghai"} onChange={(event) => setDailyReport((current) => ({ ...current, timezone: event.target.value }))}>
              <option>Asia/Shanghai</option>
              <option>UTC</option>
              <option>America/New_York</option>
            </select>
          </label>
          <label className="grid gap-2 border-b border-ops-line p-5 text-sm font-bold text-ops-muted lg:border-b-0 lg:border-r">机器人
            <select className={inputClass} value={dailyReport.bot || "Trader1"} onChange={(event) => setDailyReport((current) => ({ ...current, bot: event.target.value }))}>
              <option>Trader1</option>
              <option>YUBITadmin</option>
            </select>
          </label>
          <div className="p-5 text-sm text-ops-muted">
            <strong className="text-ops-ink">绑定名称：Daily Morning Brief</strong>
            <div className="mt-2 leading-6">在「群配置」里选择类型「新闻配置」，配置名称选 Daily Morning Brief，再绑定到要发送的 Topic。</div>
          </div>
        </div>
        <div className="border-t border-ops-line p-5">
          <label className="grid gap-2 text-sm font-bold text-ops-muted">日报正文（英文）
            <textarea className="min-h-[360px] w-full rounded-lg border border-ops-line p-4 font-mono text-sm leading-6 text-ops-ink outline-none focus:border-ops-accent focus:ring-4 focus:ring-ops-accent/10" value={dailyReport.body || ""} onChange={(event) => setDailyReport((current) => ({ ...current, body: event.target.value }))} />
          </label>
          <div className="mt-3 rounded-lg bg-[#fbfcfb] px-4 py-3 text-sm font-bold text-ops-muted">{dailyStatus}</div>
        </div>
      </Card>

      <Card className="mt-5 overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-ops-line p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-black">Market Events AI</h2>
            <p className="mt-1 text-sm text-ops-muted">AI 生成英文 Market Highlights JSON 后，可使用固定封面和三条卡片式重点直接发布到 Market Events Topic。</p>
          </div>
          <button className="rounded-lg border border-ops-accent px-4 py-2 text-sm font-black text-ops-accent" onClick={saveMarketEvent}>保存提示词</button>
        </div>
        <div className="grid gap-0 border-b border-ops-line lg:grid-cols-2">
          <label className="grid gap-2 border-b border-ops-line p-5 text-sm font-bold text-ops-muted lg:border-b-0 lg:border-r">目标群 Chat ID
            <input className={inputClass} value={marketEvent.chatId || ""} onChange={(event) => setMarketEvent((current) => ({ ...current, chatId: event.target.value }))} />
          </label>
          <label className="grid gap-2 p-5 text-sm font-bold text-ops-muted">Market Events Thread ID
            <input className={inputClass} value={marketEvent.threadId || ""} onChange={(event) => setMarketEvent((current) => ({ ...current, threadId: event.target.value }))} />
          </label>
        </div>
        <div className="grid gap-0 lg:grid-cols-2">
          <label className="grid gap-2 border-b border-ops-line p-5 text-sm font-bold text-ops-muted lg:border-b-0 lg:border-r">AI 提示词
            <textarea className="min-h-[360px] w-full rounded-lg border border-ops-line p-4 font-mono text-sm leading-6 text-ops-ink outline-none focus:border-ops-accent focus:ring-4 focus:ring-ops-accent/10" value={marketEvent.prompt || ""} onChange={(event) => setMarketEvent((current) => ({ ...current, prompt: event.target.value }))} />
          </label>
          <div className="grid gap-3 p-5">
            <label className="grid gap-2 text-sm font-bold text-ops-muted">AI 输出 JSON
              <textarea className="min-h-[290px] w-full rounded-lg border border-ops-line p-4 font-mono text-sm leading-6 text-ops-ink outline-none focus:border-ops-accent focus:ring-4 focus:ring-ops-accent/10" value={marketEventOutput} onChange={(event) => setMarketEventOutput(event.target.value)} placeholder={'{"title":"Market Highlights (Jul 13)","highlights":[{"heading":"...","detail":"..."},{"heading":"...","detail":"..."},{"heading":"...","detail":"..."}]}'} />
            </label>
            <button className="rounded-lg bg-ops-accent px-4 py-3 text-sm font-black text-white" onClick={publishMarketEvent}>发布到 Market Events</button>
            <div className="rounded-lg bg-[#fbfcfb] px-4 py-3 text-sm font-bold text-ops-muted">{marketEventStatus}</div>
          </div>
        </div>
      </Card>
      </>}

      {activeNewsTab === "sources" && <>
      <Card className="mt-5 overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-ops-line p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-black">每日 BTC/ETH & 美股看图分析</h2>
            <p className="mt-1 text-sm text-ops-muted">配置 Daily Chart Analysis。到点后会发送 BTC/ETH 合约图卡和美股 TradFi 图卡。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="rounded-lg border border-ops-accent px-4 py-2 text-sm font-black text-ops-accent" onClick={saveChartAnalysis}>保存配置</button>
            <button className="rounded-lg bg-ops-accent px-4 py-2 text-sm font-black text-white" onClick={testChartAnalysis}>测试发送</button>
          </div>
        </div>
        <div className="grid gap-0 lg:grid-cols-[220px_220px_180px_220px_minmax(0,1fr)]">
          <label className="grid gap-2 border-b border-ops-line p-5 text-sm font-bold text-ops-muted lg:border-b-0 lg:border-r">发送时间
            <input className={inputClass} type="time" value={chartAnalysis.reportTime || "09:00"} onChange={(event) => setChartAnalysis((current) => ({ ...current, reportTime: event.target.value }))} />
          </label>
          <label className="grid gap-2 border-b border-ops-line p-5 text-sm font-bold text-ops-muted lg:border-b-0 lg:border-r">时区
            <select className={inputClass} value={chartAnalysis.timezone || "Asia/Shanghai"} onChange={(event) => setChartAnalysis((current) => ({ ...current, timezone: event.target.value }))}>
              <option>Asia/Shanghai</option>
              <option>UTC</option>
              <option>America/New_York</option>
            </select>
          </label>
          <label className="grid gap-2 border-b border-ops-line p-5 text-sm font-bold text-ops-muted lg:border-b-0 lg:border-r">周期
            <select className={inputClass} value={chartAnalysis.chartInterval || "1h"} onChange={(event) => setChartAnalysis((current) => ({ ...current, chartInterval: event.target.value }))}>
              <option>15m</option>
              <option>1h</option>
              <option>4h</option>
              <option>1d</option>
            </select>
          </label>
          <label className="grid gap-2 border-b border-ops-line p-5 text-sm font-bold text-ops-muted lg:border-b-0 lg:border-r">机器人
            <select className={inputClass} value={chartAnalysis.bot || "Trader1"} onChange={(event) => setChartAnalysis((current) => ({ ...current, bot: event.target.value }))}>
              <option>Trader1</option>
              <option>YUBITadmin</option>
            </select>
          </label>
          <div className="p-5 text-sm text-ops-muted">
            <strong className="text-ops-ink">绑定名称：Daily Chart Analysis</strong>
            <div className="mt-2 leading-6">在「群配置」里选择类型「新闻配置」，配置名称选 Daily Chart Analysis，再绑定到要发送的 Topic。</div>
          </div>
        </div>
        <div className="grid gap-0 border-t border-ops-line lg:grid-cols-2">
          <label className="grid gap-2 border-b border-ops-line p-5 text-sm font-bold text-ops-muted lg:border-b-0 lg:border-r">加密标的
            <input className={inputClass} value={(Array.isArray(chartAnalysis.symbols) ? chartAnalysis.symbols : symbolsFromText(chartAnalysis.symbols)).join(", ")} onChange={(event) => setChartAnalysis((current) => ({ ...current, symbols: symbolsFromText(event.target.value) }))} />
          </label>
          <label className="grid gap-2 p-5 text-sm font-bold text-ops-muted">美股观察池
            <input className={inputClass} value={chartAnalysis.stockUniverse || ""} onChange={(event) => setChartAnalysis((current) => ({ ...current, stockUniverse: event.target.value }))} />
          </label>
        </div>
        <div className="border-t border-ops-line p-5">
          <label className="grid gap-2 text-sm font-bold text-ops-muted">分析要求
            <textarea className="min-h-[120px] w-full rounded-lg border border-ops-line p-4 font-mono text-sm leading-6 text-ops-ink outline-none focus:border-ops-accent focus:ring-4 focus:ring-ops-accent/10" value={chartAnalysis.body || ""} onChange={(event) => setChartAnalysis((current) => ({ ...current, body: event.target.value }))} />
          </label>
          <div className="mt-3 rounded-lg bg-[#fbfcfb] px-4 py-3 text-sm font-bold text-ops-muted">{chartStatus}</div>
        </div>
      </Card>
      </>}

      <Card className="mt-5 overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-ops-line p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-black">大户挂单 & 巨鲸数据源</h2>
            <p className="mt-1 text-sm text-ops-muted">这些源会用于 Smart Money Tracker。免费源可以先跑，专业链上标签和 ETF/爆仓数据需要 key。</p>
          </div>
          <button className="rounded-lg bg-ops-accent px-4 py-2 text-sm font-black text-white" onClick={testSmartMoney}>测试免费监控</button>
        </div>
        <div className="grid gap-0 border-b border-ops-line md:grid-cols-4">
          <MetricBox label="免费可用" value={smartMoneySources.filter((source) => source.access === "No key").length} sub="无需 key，当前可跑" />
          <MetricBox label="免费试用" value={smartMoneySources.filter((source) => source.access.toLowerCase().includes("trial")).length} sub="试用后付费" />
          <MetricBox label="需要 Key" value={smartMoneySources.filter((source) => source.env).length} sub="申请 key 后接入" />
          <MetricBox label="推送脚本" value="已接入" sub="smart-money-monitor.mjs" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-sm">
            <thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted">
              <tr><th className="px-5 py-3">数据源</th><th className="px-5 py-3">费用</th><th className="px-5 py-3">适合监控</th><th className="px-5 py-3">环境变量</th><th className="px-5 py-3">状态</th></tr>
            </thead>
            <tbody>
              {smartMoneySources.map((source) => (
                <tr className="border-t border-ops-line align-top" key={source.name}>
                  <td className="px-5 py-4"><strong>{source.name}</strong><div className="mt-1 max-w-sm break-all font-mono text-xs text-ops-muted">{source.endpoint}</div></td>
                  <td className="px-5 py-4"><span className={`rounded-full px-2 py-1 text-xs font-black ${smartTone(source)}`}>{source.access}</span></td>
                  <td className="px-5 py-4">{source.coverage}<div className="mt-1 text-xs text-ops-muted">{source.note}</div></td>
                  <td className="px-5 py-4 font-mono text-xs">{source.env || "无需配置"}</td>
                  <td className="px-5 py-4">{source.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </ConsoleShell>
  );
}

const defaultMarketEventPrompt = `You are the YUBIT Market Events editor. Convert supplied market news into a concise, factual Telegram post.

Return valid JSON only:
{
  "title": "Market Highlights (Mon D)",
  "highlights": [
    { "heading": "Short headline", "detail": "One concise sentence with only material facts and figures." }
  ]
}

Rules:
- Write in clear English.
- Select exactly 3 most material highlights.
- Keep each heading to 4–9 words and each detail to 1–2 short sentences.
- Preserve supplied dates, tickers, percentages, and dollar amounts exactly.
- Do not add facts, forecasts, trade calls, hype, or investment advice.
- Keep the complete Telegram caption below 900 characters.
- Do not add Markdown, explanations, or any text outside the JSON.`;

function canPreview(source) {
  return source.kind.includes("RSS") && !source.endpoint.includes("$") && /^https?:\/\//.test(source.endpoint) && !/key|required|payment|付费|密钥/i.test(`${source.status} ${source.access}`);
}

function stateLabel(state) {
  return {
    idle: "待测试",
    running: "测试中",
    success: "已发送",
    error: "需处理"
  }[state] || "待检查";
}

function smartTone(source) {
  if (source.access === "No key") return "bg-[#e6f7ef] text-ops-accent";
  if (source.access.toLowerCase().includes("trial")) return "bg-[#edf7f2] text-ops-accent";
  return "bg-[#fff4df] text-[#c98118]";
}

function symbolsFromText(value) {
  return String(value || "")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
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
