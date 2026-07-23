"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, StatusPill, inputClass } from "../components/ui";

const eventLabels = {
  page_view: "页面访问",
  cta_click: "按钮点击",
  video_play: "视频播放",
  heartbeat: "活跃停留",
  session_end: "会话结束"
};

function number(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function duration(seconds) {
  const value = Number(seconds || 0);
  return value < 60 ? `${value} 秒` : `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
}

function time(value) {
  return value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "暂无数据";
}

function MetricCard({ label, value, detail, accent = false }) {
  return <Card className={`min-w-0 p-4 ${accent ? "border-ops-accent bg-[#f3faf6]" : ""}`}>
    <p className="text-xs font-black text-ops-muted">{label}</p>
    <p className="mt-2 break-words text-2xl font-black tracking-tight text-ops-ink sm:text-3xl">{value}</p>
    <p className="mt-1 text-xs leading-5 text-ops-muted">{detail}</p>
  </Card>;
}

function TrendChart({ points = [] }) {
  const width = 760;
  const height = 210;
  const inset = 18;
  const max = Math.max(...points.map((item) => Number(item.pv || 0)), 1);
  const chartPoints = points.map((item, index) => ({
    x: inset + (index / Math.max(points.length - 1, 1)) * (width - inset * 2),
    y: height - inset - (Number(item.pv || 0) / max) * (height - inset * 2)
  }));
  const line = chartPoints.map((point) => `${point.x},${point.y}`).join(" ");
  const area = chartPoints.length ? `${inset},${height - inset} ${line} ${width - inset},${height - inset}` : "";
  const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 3), Math.floor(((points.length - 1) * 2) / 3), points.length - 1])].filter((index) => index >= 0);

  return <div>
    <div className="h-[210px] w-full" aria-label="PV 趋势图" role="img">
      <svg className="h-full w-full" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
        <defs><linearGradient id="siteAnalyticsArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#159b68" stopOpacity=".24"/><stop offset="100%" stopColor="#159b68" stopOpacity="0"/></linearGradient></defs>
        {[.25, .5, .75].map((level) => <line key={level} stroke="#e2e8e5" strokeWidth="1" x1={inset} x2={width - inset} y1={height * level} y2={height * level} />)}
        {area ? <polygon fill="url(#siteAnalyticsArea)" points={area} /> : null}
        {line ? <polyline fill="none" points={line} stroke="#159b68" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
    </div>
    <div className="flex justify-between text-[11px] font-bold text-ops-muted">{labelIndexes.map((index) => <span key={index}>{points[index]?.date?.slice(5).replace("-", "/")}</span>)}</div>
  </div>;
}

function FunnelRow({ label, value, rate, width }) {
  return <div>
    <div className="mb-2 flex items-center justify-between gap-3 text-sm"><span className="font-black text-ops-ink">{label}</span><span className="text-right font-black">{number(value)} <small className="ml-1 text-ops-muted">{rate}</small></span></div>
    <div className="h-2 overflow-hidden rounded-full bg-[#edf1ef]"><div className="h-full rounded-full bg-ops-accent" style={{ width: `${Math.max(Math.min(width, 100), value ? 3 : 0)}%` }} /></div>
  </div>;
}

export default function SiteAnalyticsPanel() {
  const [range, setRange] = useState("30d");
  const [site, setSite] = useState("all");
  const [siteOptions, setSiteOptions] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const selectSite = (nextSite) => {
    setSite(nextSite);
    document.getElementById("site-analytics-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const load = useCallback(async (soft = false) => {
    soft ? setRefreshing(true) : setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/site-analytics?range=${range}&site=${encodeURIComponent(site)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "站点数据读取失败");
      setData(payload.data);
      if (site === "all") setSiteOptions(payload.data.sites || []);
    } catch (reason) {
      setError(reason.message || "站点数据读取失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [range, site]);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load(true), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const kpis = data?.kpis || {};
  const funnel = useMemo(() => {
    const sessions = Number(kpis.sessions || 0);
    return [
      { label: "访问会话", value: sessions, rate: "基准", width: 100 },
      { label: "播放视频", value: kpis.videoPlays, rate: `${kpis.videoPlayRate || 0}%`, width: kpis.videoPlayRate || 0 },
      { label: "点击 Telegram", value: kpis.ctaClicks, rate: `${kpis.ctaRate || 0}%`, width: kpis.ctaRate || 0 }
    ];
  }, [kpis]);

  return <section aria-label="代理网站数据" className="grid gap-5" id="site-analytics-panel">
    <div className="flex flex-col gap-3 rounded-lg border border-ops-line bg-white p-4 shadow-ops lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-black">代理网站经营数据</h2><StatusPill tone={data?.dataMode === "live" ? "green" : "amber"}>{data?.dataMode === "live" ? "真实数据" : "等待真实数据"}</StatusPill></div>
        <p className="mt-1 text-sm leading-6 text-ops-muted">统一查看 PV、UV、Telegram 按钮转化、视频播放和有效停留；每 30 秒自动刷新。</p>
      </div>
      <div className="grid shrink-0 gap-2 sm:grid-cols-[minmax(150px,1fr)_120px_auto]">
        <select aria-label="筛选网站" autoComplete="off" className={inputClass} onChange={(event) => setSite(event.target.value)} value={site}><option value="all">全部网站</option>{siteOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <select aria-label="统计周期" className={inputClass} onChange={(event) => setRange(event.target.value)} value={range}><option value="7d">近 7 天</option><option value="30d">近 30 天</option><option value="90d">近 90 天</option></select>
        <button className="min-h-10 rounded-lg border border-ops-accent px-4 text-sm font-black text-ops-accent disabled:opacity-50" disabled={refreshing} onClick={() => load(true)} type="button">{refreshing ? "刷新中…" : "刷新"}</button>
      </div>
    </div>

    {error ? <div className="rounded-lg border border-[#d85f5f] bg-[#fff5f4] px-4 py-3 text-sm font-bold text-[#a43e35]" role="alert">{error}</div> : null}
    {loading ? <Card className="p-8 text-center font-bold text-ops-muted">正在读取站点数据…</Card> : null}

    {!loading && data ? <>
      {data.dataMode !== "live" ? <div className="rounded-lg border border-[#d9bd73] bg-[#fff9e8] px-4 py-3 text-xs leading-5 text-[#7b642f]"><strong>当前还没有符合筛选条件的真实访问。</strong> 页面不再用演示数据填充指标；接入站点产生访问后，会自动显示真实 PV、UV、点击、播放和停留数据。</div> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="页面浏览量 PV" value={number(kpis.pv)} detail={`近 ${data.rangeDays} 天累计页面访问`} />
        <MetricCard label="独立访客 UV" value={number(kpis.uv)} detail={`${number(kpis.sessions)} 次访问会话`} />
        <MetricCard accent label="Telegram 点击率" value={`${kpis.ctaRate || 0}%`} detail={`${number(kpis.ctaClicks)} 次按钮点击`} />
        <MetricCard accent label="视频播放率" value={`${kpis.videoPlayRate || 0}%`} detail={`${number(kpis.videoPlays)} 次开始播放`} />
        <MetricCard label="平均有效停留" value={duration(kpis.avgDwellSeconds)} detail="按会话累计活跃停留" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,.8fr)]">
        <Card className="min-w-0 p-5"><div className="mb-3 flex items-end justify-between gap-3"><div><h3 className="text-lg font-black">访问趋势</h3><p className="mt-1 text-xs text-ops-muted">每日 PV 变化</p></div><span className="text-xs font-bold text-ops-muted">更新于 {time(data.generatedAt)}</span></div><TrendChart points={data.trend} /></Card>
        <Card className="p-5"><h3 className="text-lg font-black">转化漏斗</h3><p className="mt-1 text-xs text-ops-muted">以访问会话为统一基准</p><div className="mt-6 grid gap-6">{funnel.map((item) => <FunnelRow key={item.label} {...item} />)}</div></Card>
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-ops-line p-5"><h3 className="text-lg font-black">网站表现</h3><p className="mt-1 text-xs text-ops-muted">所有代理站点统一收录，桌面端表格与手机端卡片均不会遮挡文字。</p></div>
        <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[860px] text-left text-sm"><thead className="bg-[#f9fbfa] text-xs text-ops-muted"><tr><th className="px-5 py-3">网站</th><th className="px-5 py-3">PV / UV</th><th className="px-5 py-3">CTA 点击率</th><th className="px-5 py-3">视频播放率</th><th className="px-5 py-3">平均停留</th><th className="px-5 py-3">最后事件</th><th className="px-5 py-3">操作</th></tr></thead><tbody>{data.sites.map((item) => <tr className="border-t border-ops-line" key={item.id}><td className="max-w-64 px-5 py-4"><p className="font-black">{item.name}</p><p className="mt-1 break-all text-xs text-ops-muted">{item.domain}</p></td><td className="px-5 py-4 font-black">{number(item.pv)} / {number(item.uv)}</td><td className="px-5 py-4 font-black text-ops-accent">{item.ctaRate}%</td><td className="px-5 py-4 font-black">{item.videoPlayRate}%</td><td className="px-5 py-4">{duration(item.avgDwellSeconds)}</td><td className="px-5 py-4 text-xs text-ops-muted">{time(item.lastEventAt)}</td><td className="px-5 py-4"><div className="flex flex-wrap gap-2"><button className="rounded-md border border-ops-accent px-2 py-1 text-xs font-black text-ops-accent" onClick={() => selectSite(item.id)} type="button">只看此站</button><a className="rounded-md bg-ops-accent px-2 py-1 text-xs font-black text-white" href={item.domain} rel="noopener noreferrer" target="_blank">打开网站</a></div></td></tr>)}</tbody></table></div>
        <div className="divide-y divide-ops-line md:hidden">{data.sites.map((item) => <article className="p-4" key={item.id}><h4 className="font-black">{item.name}</h4><p className="mt-1 break-all text-xs text-ops-muted">{item.domain}</p><dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-ops-muted">PV / UV</dt><dd className="mt-1 font-black">{number(item.pv)} / {number(item.uv)}</dd></div><div><dt className="text-xs text-ops-muted">CTA / 播放率</dt><dd className="mt-1 font-black text-ops-accent">{item.ctaRate}% / {item.videoPlayRate}%</dd></div><div><dt className="text-xs text-ops-muted">平均停留</dt><dd className="mt-1 font-black">{duration(item.avgDwellSeconds)}</dd></div><div><dt className="text-xs text-ops-muted">最后事件</dt><dd className="mt-1 text-xs font-bold">{time(item.lastEventAt)}</dd></div></dl><div className="mt-4 grid grid-cols-2 gap-2"><button className="min-h-10 rounded-md border border-ops-accent px-3 text-xs font-black text-ops-accent" onClick={() => selectSite(item.id)} type="button">只看此站</button><a className="flex min-h-10 items-center justify-center rounded-md bg-ops-accent px-3 text-xs font-black text-white" href={item.domain} rel="noopener noreferrer" target="_blank">打开网站</a></div></article>)}</div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5"><h3 className="text-lg font-black">按钮点击排行</h3><div className="mt-4 grid gap-3">{data.topCtas.length ? data.topCtas.map((item, index) => <div className="flex items-center justify-between gap-3 rounded-lg bg-[#f7faf8] px-4 py-3" key={item.elementId}><span className="min-w-0 break-words text-sm font-bold"><small className="mr-2 text-ops-muted">{index + 1}</small>{item.elementId}</span><strong className="shrink-0 text-ops-accent">{number(item.clicks)} 次</strong></div>) : <p className="py-6 text-center text-sm font-bold text-ops-muted">暂无按钮点击。</p>}</div></Card>
        <Card className="p-5"><h3 className="text-lg font-black">最近事件</h3><div className="mt-4 grid gap-3">{data.recentEvents.slice(0, 6).map((item) => <div className="flex items-start justify-between gap-3 border-b border-ops-line pb-3 last:border-0 last:pb-0" key={item.id}><div className="min-w-0"><p className="text-sm font-black">{item.siteName} · {eventLabels[item.eventType] || item.eventType}</p><p className="mt-1 break-all text-xs text-ops-muted">{item.path}{item.elementId ? ` · ${item.elementId}` : ""}</p></div><time className="shrink-0 text-xs text-ops-muted">{time(item.occurredAt)}</time></div>)}</div></Card>
      </div>
    </> : null}
  </section>;
}
