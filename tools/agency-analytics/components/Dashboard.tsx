"use client";

import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Copy,
  Eye,
  Gauge,
  Globe2,
  LayoutDashboard,
  Link2,
  Menu,
  MousePointerClick,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnalyticsResponse, Site, TrendPoint } from "@/lib/shared/types";

type View = "overview" | "sites" | "events" | "setup";

const eventLabels = {
  page_view: "页面访问",
  cta_click: "按钮点击",
  video_play: "视频播放",
  heartbeat: "活跃停留",
  session_end: "会话结束",
};

const navItems: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: "overview", label: "经营概览", icon: LayoutDashboard },
  { id: "sites", label: "网站资产", icon: Globe2 },
  { id: "events", label: "事件明细", icon: Activity },
  { id: "setup", label: "接入中心", icon: Code2 },
];

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`;
}

function formatTime(value: string | null) {
  if (!value) return "暂无数据";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function TrendChart({ data }: { data: TrendPoint[] }) {
  const width = 780;
  const height = 238;
  const inset = 16;
  const max = Math.max(...data.map((item) => item.pv), 1);
  const points = data.map((item, index) => ({
    x: inset + (index / Math.max(data.length - 1, 1)) * (width - inset * 2),
    y: height - inset - (item.pv / max) * (height - inset * 2),
    value: item.pv,
  }));
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${inset},${height - inset} ${line} ${width - inset},${height - inset}`;
  const tickIndexes = [...new Set([0, Math.floor((data.length - 1) / 3), Math.floor(((data.length - 1) * 2) / 3), data.length - 1])];

  return (
    <div className="chart-wrap" aria-label="PV 趋势图">
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#b7f25c" stopOpacity=".34" />
            <stop offset="100%" stopColor="#b7f25c" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((level) => (
          <line key={level} x1={inset} x2={width - inset} y1={height * level} y2={height * level} className="chart-grid" />
        ))}
        <polygon points={area} fill="url(#areaFill)" />
        <polyline points={line} className="chart-line" />
        {points.map((point, index) => (
          <circle key={index} cx={point.x} cy={point.y} r="3.5" className="chart-dot">
            <title>{`${data[index].date}: ${point.value} PV`}</title>
          </circle>
        ))}
      </svg>
      <div className="chart-labels">
        {tickIndexes.map((index) => <span key={index}>{data[index]?.date.slice(5).replace("-", "/")}</span>)}
      </div>
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, hint, tone }: {
  icon: typeof Activity;
  label: string;
  value: string;
  hint: string;
  tone: string;
}) {
  return (
    <article className="kpi-card">
      <div className={`kpi-icon ${tone}`}><Icon size={18} /></div>
      <div className="kpi-copy"><span>{label}</span><strong>{value}</strong></div>
      <p>{hint}</p>
    </article>
  );
}

function Skeleton() {
  return (
    <div className="loading-grid" aria-label="正在加载数据">
      {Array.from({ length: 8 }).map((_, index) => <div className="skeleton" key={index} />)}
    </div>
  );
}

export default function Dashboard() {
  const [view, setView] = useState<View>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [range, setRange] = useState("30d");
  const [siteId, setSiteId] = useState("all");
  const [sites, setSites] = useState<Site[]>([]);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async (soft = false) => {
    soft ? setRefreshing(true) : setLoading(true);
    setError("");
    try {
      const [analyticsResponse, sitesResponse] = await Promise.all([
        fetch(`/api/analytics?range=${range}&site=${siteId}`, { cache: "no-store" }),
        fetch("/api/sites", { cache: "no-store" }),
      ]);
      if (!analyticsResponse.ok || !sitesResponse.ok) throw new Error("数据服务暂时不可用");
      const analyticsPayload = await analyticsResponse.json();
      const sitesPayload = await sitesResponse.json();
      setData(analyticsPayload.data);
      setSites(sitesPayload.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [range, siteId]);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load(true), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const selectedSite = sites.find((site) => site.id === siteId) || sites[0];
  const collectorOrigin = typeof window === "undefined" ? "http://127.0.0.1:3100" : window.location.origin;
  const snippet = selectedSite
    ? `<script defer src="${collectorOrigin}/tracker.js?site=${selectedSite.id}&key=${selectedSite.apiKey}"></script>`
    : "请先添加一个网站";
  const filteredSites = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return data?.sites || [];
    return (data?.sites || []).filter((site) => `${site.name} ${site.domain}`.toLowerCase().includes(keyword));
  }, [data?.sites, search]);

  async function createSite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: form.get("name"), domain: form.get("domain") }),
    });
    if (!response.ok) {
      const payload = await response.json();
      setError(payload.error?.message || "网站添加失败");
      return;
    }
    setShowCreate(false);
    await load(true);
  }

  async function copySnippet() {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  const kpis = data?.kpis;
  const maxCta = Math.max(...(data?.topCtas.map((item) => item.clicks) || [1]), 1);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Activity size={21} /></div>
          <div><strong>SITE NERVE</strong><span>代理站点运营中台</span></div>
          <button className="mobile-close" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X /></button>
        </div>
        <nav>
          <p className="nav-label">工作区</p>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => { setView(item.id); setMobileNav(false); }}>
                <Icon size={18} /><span>{item.label}</span>{view === item.id && <ChevronRight size={15} />}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-status">
          <div className="pulse"><span /><Activity size={15} /></div>
          <div><strong>采集服务运行中</strong><span>数据保存在当前服务器</span></div>
        </div>
        <div className="operator"><div className="avatar">Y</div><div><strong>运营管理员</strong><span>Local workspace</span></div><Settings2 size={17} /></div>
      </aside>

      {mobileNav && <button className="nav-backdrop" onClick={() => setMobileNav(false)} aria-label="关闭导航" />}

      <main className="main-content">
        <header className="topbar">
          <button className="menu-button" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu /></button>
          <div className="top-title">
            <span>{navItems.find((item) => item.id === view)?.label}</span>
            <small>全站数据每 30 秒自动刷新</small>
          </div>
          <div className="top-actions">
            <label className="select-control site-filter"><Globe2 size={16} /><select value={siteId} onChange={(event) => setSiteId(event.target.value)}><option value="all">全部网站</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
            <label className="select-control range-filter"><select value={range} onChange={(event) => setRange(event.target.value)}><option value="7d">近 7 天</option><option value="30d">近 30 天</option><option value="90d">近 90 天</option></select></label>
            <button className="icon-button" onClick={() => load(true)} aria-label="刷新数据"><RefreshCw className={refreshing ? "spin" : ""} size={18} /></button>
            <button className="primary-button" onClick={() => setShowCreate(true)}><Plus size={17} />添加网站</button>
          </div>
        </header>

        <div className="page-body">
          {data && data.dataMode !== "live" && (
            <div className="demo-banner">
              <Sparkles size={17} />
              <span><strong>{data.dataMode === "demo" ? "当前为演示数据" : "当前混合展示演示与真实数据"}</strong> · 接入追踪代码后，新事件会自动进入本地数据库。</span>
              <button onClick={() => setView("setup")}>查看接入方式 <ArrowUpRight size={14} /></button>
            </div>
          )}
          {error && <div className="error-banner">{error}<button onClick={() => load()}>重试</button></div>}
          {loading ? <Skeleton /> : data && (
            <>
              {view === "overview" && (
                <section className="view-stack">
                  <div className="hero-row">
                    <div><p className="eyebrow">PERFORMANCE PULSE</p><h1>看清每一个站点，<br /><em>抓住每一次转化。</em></h1><p>统一追踪流量、兴趣与行动，让代理站增长不再靠猜。</p></div>
                    <div className="hero-orbit" aria-hidden="true"><div className="orbit-ring" /><div className="orbit-core"><Gauge size={37} /><strong>{kpis?.ctaRate || 0}%</strong><span>按钮转化</span></div><span className="orbit-dot dot-one" /><span className="orbit-dot dot-two" /></div>
                  </div>
                  <div className="kpi-grid">
                    <KpiCard icon={Eye} label="浏览量 PV" value={formatNumber(kpis?.pv || 0)} hint="页面被查看的总次数" tone="lime" />
                    <KpiCard icon={Users} label="独立访客 UV" value={formatNumber(kpis?.uv || 0)} hint={`${formatNumber(kpis?.sessions || 0)} 次访问会话`} tone="cyan" />
                    <KpiCard icon={MousePointerClick} label="按钮点击率" value={`${kpis?.ctaRate || 0}%`} hint={`${formatNumber(kpis?.ctaClicks || 0)} 次有效点击`} tone="violet" />
                    <KpiCard icon={Play} label="视频播放率" value={`${kpis?.videoPlayRate || 0}%`} hint={`${formatNumber(kpis?.videoPlays || 0)} 次开始播放`} tone="orange" />
                    <KpiCard icon={Clock3} label="平均停留时长" value={formatDuration(kpis?.avgDwellSeconds || 0)} hint="按活跃会话计算" tone="pink" />
                  </div>
                  <div className="dashboard-grid">
                    <article className="panel trend-panel">
                      <div className="panel-head"><div><span className="panel-kicker">TRAFFIC</span><h2>访问趋势</h2></div><div className="legend"><span className="legend-dot" />PV</div></div>
                      <TrendChart data={data.trend} />
                    </article>
                    <article className="panel funnel-panel">
                      <div className="panel-head"><div><span className="panel-kicker">FUNNEL</span><h2>流量效率</h2></div><BarChart3 size={19} /></div>
                      <div className="funnel-list">
                        {[
                          ["到达页面", kpis?.sessions || 0, 100],
                          ["播放视频", kpis?.videoPlays || 0, kpis?.videoPlayRate || 0],
                          ["点击按钮", kpis?.ctaClicks || 0, kpis?.ctaRate || 0],
                        ].map(([label, value, rate], index) => (
                          <div className="funnel-row" key={String(label)}><div className="funnel-number">0{index + 1}</div><div className="funnel-data"><div><span>{label}</span><strong>{formatNumber(Number(value))}</strong></div><div className="progress"><i style={{ width: `${Math.max(Number(rate), 3)}%` }} /></div></div><b>{Number(rate).toFixed(index ? 1 : 0)}%</b></div>
                        ))}
                      </div>
                    </article>
                  </div>
                  <div className="dashboard-grid lower-grid">
                    <SiteTable sites={data.sites} onOpen={(id) => { setSiteId(id); setView("sites"); }} />
                    <article className="panel cta-panel"><div className="panel-head"><div><span className="panel-kicker">CTA RANKING</span><h2>按钮热度</h2></div><MousePointerClick size={19} /></div><div className="cta-list">{data.topCtas.map((item, index) => <div className="cta-item" key={item.elementId}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{item.elementId}</strong><i><b style={{ width: `${(item.clicks / maxCta) * 100}%` }} /></i></div><em>{item.clicks}</em></div>)}</div></article>
                  </div>
                </section>
              )}

              {view === "sites" && (
                <section className="view-stack">
                  <div className="section-heading"><div><p className="eyebrow">SITE DIRECTORY</p><h1>网站资产</h1><p>集中查看所有代理网站的状态与核心表现。</p></div><button className="primary-button" onClick={() => setShowCreate(true)}><Plus size={17} />收录新网站</button></div>
                  <div className="toolbar"><label className="search-control"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索网站名称或域名" /></label><span>{filteredSites.length} 个网站</span></div>
                  <SiteTable sites={filteredSites} onOpen={(id) => setSiteId(id)} expanded />
                </section>
              )}

              {view === "events" && (
                <section className="view-stack">
                  <div className="section-heading"><div><p className="eyebrow">EVENT STREAM</p><h1>事件明细</h1><p>最近采集的用户行为，按发生时间倒序排列。</p></div><span className="live-badge"><i /> LIVE</span></div>
                  <article className="panel events-panel">
                    <div className="event-head"><span>事件</span><span>网站</span><span>页面 / 元素</span><span>时间</span></div>
                    {data.recentEvents.map((event) => <div className="event-row" key={event.id}><span className={`event-type ${event.eventType}`}><CircleDot size={14} />{eventLabels[event.eventType]}</span><strong>{event.siteName}</strong><span><b>{event.path}</b>{event.elementId && <small>{event.elementId}</small>}</span><time>{formatTime(event.occurredAt)}</time></div>)}
                  </article>
                </section>
              )}

              {view === "setup" && (
                <section className="view-stack">
                  <div className="section-heading"><div><p className="eyebrow">INSTALLATION</p><h1>接入中心</h1><p>复制一行代码，即可开始采集 PV、UV、按钮、视频与停留时长。</p></div></div>
                  <div className="setup-grid">
                    <article className="panel setup-main"><span className="step-badge">01</span><h2>选择要接入的网站</h2><label className="large-select"><Globe2 size={19} /><select value={selectedSite?.id || ""} onChange={(event) => setSiteId(event.target.value)}>{sites.map((site) => <option key={site.id} value={site.id}>{site.name} · {site.domain}</option>)}</select></label><span className="step-badge">02</span><h2>粘贴到网页的 &lt;head&gt; 中</h2><div className="code-box"><code>{snippet}</code><button onClick={copySnippet}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? "已复制" : "复制代码"}</button></div><div className="notice"><Link2 size={18} /><p><strong>生产环境请使用 HTTPS 地址</strong><span>页面部署到服务器后，这里的代码会自动使用同一采集域名；无需在代理站保存管理后台密码。</span></p></div></article>
                    <aside className="setup-side"><article className="panel"><span className="step-badge">03</span><h2>自动识别以下行为</h2><ul className="check-list"><li><Check /> 页面浏览与独立访客</li><li><Check /> 链接及按钮点击</li><li><Check /> HTML5 视频播放</li><li><Check /> 页面活跃停留时长</li><li><Check /> 单页应用路由变化</li></ul></article><article className="panel privacy-card"><div className="privacy-icon"><Settings2 /></div><h3>隐私优先</h3><p>访客 ID 随机生成并保存在浏览器内，不采集姓名、手机号或输入内容。</p></article></aside>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </main>

      {showCreate && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="create-title">
          <button className="modal-backdrop" onClick={() => setShowCreate(false)} aria-label="关闭" />
          <form className="modal-card" onSubmit={createSite}><div className="modal-head"><div><span className="panel-kicker">NEW PROPERTY</span><h2 id="create-title">收录新网站</h2></div><button type="button" onClick={() => setShowCreate(false)}><X /></button></div><label>网站名称<input name="name" minLength={2} maxLength={80} placeholder="例如：Crypto Guy VIP" required /></label><label>网站域名<input name="domain" type="url" placeholder="https://example.com" required /></label><p>添加后会生成独立的追踪密钥和接入代码。</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowCreate(false)}>取消</button><button className="primary-button" type="submit">创建并生成代码</button></div></form>
        </div>
      )}
    </div>
  );
}

function SiteTable({ sites, onOpen, expanded = false }: { sites: AnalyticsResponse["sites"]; onOpen: (id: string) => void; expanded?: boolean }) {
  return (
    <article className={`panel sites-panel ${expanded ? "expanded" : ""}`}>
      <div className="panel-head"><div><span className="panel-kicker">PROPERTIES</span><h2>网站表现</h2></div>{!expanded && <button className="text-button">全部网站 <ArrowUpRight size={14} /></button>}</div>
      <div className="site-table">
        <div className="site-head"><span>网站</span><span>PV / UV</span><span>点击率</span><span>视频率</span><span>状态</span><span /></div>
        {sites.map((site) => <div className="site-row" key={site.id}><div className="site-name"><div>{site.name.slice(0, 1).toUpperCase()}</div><span><strong>{site.name}</strong><small>{site.domain.replace(/^https?:\/\//, "")}</small></span></div><span><strong>{formatNumber(site.pv)}</strong><small>{formatNumber(site.uv)} UV</small></span><span><strong>{site.ctaRate}%</strong><small>{site.ctaClicks} 点击</small></span><span><strong>{site.videoPlayRate}%</strong><small>{site.videoPlays} 播放</small></span><span className="status-pill"><i />{site.isDemo ? "演示" : "运行中"}</span><button onClick={() => onOpen(site.id)} aria-label={`查看 ${site.name}`}><ArrowUpRight /></button></div>)}
        {!sites.length && <div className="empty-state">没有找到匹配的网站</div>}
      </div>
    </article>
  );
}
