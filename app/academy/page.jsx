"use client";

import { Award, Bot, Check, GraduationCap, Mail, MessageCircle, Play, Radio, Send, ShieldCheck, Sparkles, TrendingUp, Users } from "lucide-react";
import { useMemo, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, Field, PageHeader, inputClass } from "../components/ui";

const defaultAgent = {
  brand: "YUBIT",
  agentName: "Ricky",
  academyName: "Ricky Trading Academy",
  handle: "@ricky_yubit",
  promise: "Live market lessons, signal context, and weekly trading routines.",
  audience: "new futures traders",
  subscribers: "1,221",
  primary: "#00E5FF",
  secondary: "#F39917",
  accent: "#FF2A1F"
};

const modules = [
  { title: "品牌规范", status: "先做", desc: "字体、颜色、头像、按钮、频道头图，一次配置后全代理复用。" },
  { title: "Telegram 频道包", status: "先做", desc: "频道封面、机器人入口、Premium 群预览，能直接服务现有 TG 群转发。" },
  { title: "周内容日历", status: "先做", desc: "把信号、复盘、直播、课程内容排成一周学院节奏。" },
  { title: "YouTube 缩略图", status: "可做", desc: "用同一套模板批量换人、换币种、换标题。" },
  { title: "落地页长页", status: "可做", desc: "需要补注册/验证/入群 CTA 链路后再接。" },
  { title: "全漏斗图", status: "内部用", desc: "适合招商、复盘和给代理解释打法，不一定发给用户。" }
];

const week = [
  { day: "Mon", label: "Market Insight", icon: TrendingUp, text: "Range view, risk notes, and the one chart everyone should watch before trading." },
  { day: "Wed", label: "Trading Signal", icon: Radio, text: "Entry zone, invalidation, take-profit levels, and context from the latest market move." },
  { day: "Fri", label: "Live Stream", icon: Play, text: "Live trading recap with decisions explained step by step, then clipped into short lessons." },
  { day: "Sat", label: "Trading Lesson", icon: GraduationCap, text: "Beginner-friendly lesson turning the week's market into a repeatable routine." }
];

const thumbnails = [
  ["LIVE TRADING", "BTC SETUP", "$12,797"],
  ["ALTCOIN WATCH", "BREAKOUT", "+8.59%"],
  ["MARKET MAP", "RISK ZONES", "LIVE"],
  ["WEEKLY PLAN", "TRADE ROUTINE", "DAY 5"]
];

export default function AcademyPage() {
  const [agent, setAgent] = useState(defaultAgent);
  const cssVars = useMemo(
    () => ({
      "--academy-primary": agent.primary,
      "--academy-secondary": agent.secondary,
      "--academy-accent": agent.accent
    }),
    [agent.primary, agent.secondary, agent.accent]
  );

  function update(key, value) {
    setAgent((current) => ({ ...current, [key]: value }));
  }

  return (
    <ConsoleShell>
      <PageHeader
        title="交易学院模板"
        desc="把竞品的交易学院物料拆成可批量生成的 HTML/CSS 模板：每个代理只换名字、头像、频道链接、卖点和主题色，后面再接到现有 Telegram 转发与生成链路。"
        action={<span className="rounded-lg bg-[#e8f8f3] px-4 py-2 text-sm font-black text-ops-accent">模板层草案</span>}
      />

      <section className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <div className="border-b border-ops-line px-6 py-5">
            <h2 className="text-xl font-black">代理资料</h2>
            <p className="mt-1 text-sm leading-6 text-ops-muted">这里的字段以后可以来自代理配置 JSON 或后台表单。</p>
          </div>
          <div className="grid gap-4 p-6">
            <Field label="品牌"><input className={inputClass} value={agent.brand} onChange={(event) => update("brand", event.target.value)} /></Field>
            <Field label="代理名"><input className={inputClass} value={agent.agentName} onChange={(event) => update("agentName", event.target.value)} /></Field>
            <Field label="学院名"><input className={inputClass} value={agent.academyName} onChange={(event) => update("academyName", event.target.value)} /></Field>
            <Field label="账号"><input className={inputClass} value={agent.handle} onChange={(event) => update("handle", event.target.value)} /></Field>
            <Field label="目标用户"><input className={inputClass} value={agent.audience} onChange={(event) => update("audience", event.target.value)} /></Field>
            <Field label="一句话卖点"><textarea className={`${inputClass} min-h-24 py-3`} value={agent.promise} onChange={(event) => update("promise", event.target.value)} /></Field>
            <div className="grid grid-cols-3 gap-3">
              <ColorField label="主色" value={agent.primary} onChange={(value) => update("primary", value)} />
              <ColorField label="辅助" value={agent.secondary} onChange={(value) => update("secondary", value)} />
              <ColorField label="强调" value={agent.accent} onChange={(value) => update("accent", value)} />
            </div>
          </div>
        </Card>

        <div className="grid gap-5">
          <Card className="overflow-hidden">
            <div className="border-b border-ops-line px-6 py-5">
              <h2 className="text-xl font-black">我们可以先做什么</h2>
              <p className="mt-1 text-sm leading-6 text-ops-muted">按和现有 TG 系统的贴合度排序，先做能马上批量化、能喂给群/Topic 的资产。</p>
            </div>
            <div className="grid gap-0 md:grid-cols-2 xl:grid-cols-3">
              {modules.map((item) => (
                <div className="border-b border-ops-line p-5 md:border-r xl:[&:nth-child(3n)]:border-r-0" key={item.title}>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-black">{item.title}</h3>
                    <span className="rounded-full bg-[#edf7f2] px-2.5 py-1 text-xs font-black text-ops-accent">{item.status}</span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-ops-muted">{item.desc}</p>
                </div>
              ))}
            </div>
          </Card>

          <AcademyIntro agent={agent} cssVars={cssVars} />
        </div>
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <FunnelBoard cssVars={cssVars} />
        <TelegramPack agent={agent} cssVars={cssVars} />
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <ThumbnailGrid agent={agent} cssVars={cssVars} />
        <WeekSchedule agent={agent} cssVars={cssVars} />
      </section>
    </ConsoleShell>
  );
}

function ColorField({ label, value, onChange }) {
  return (
    <label className="grid gap-1.5 text-sm font-bold text-ops-muted">
      {label}
      <span className="flex min-h-10 overflow-hidden rounded-lg border border-ops-line bg-white">
        <input className="h-10 w-12 cursor-pointer border-0 bg-transparent p-1" type="color" value={value} onChange={(event) => onChange(event.target.value)} />
        <input className="min-w-0 flex-1 px-2 text-xs font-black uppercase outline-none" value={value} onChange={(event) => onChange(event.target.value)} />
      </span>
    </label>
  );
}

function AcademyIntro({ agent, cssVars }) {
  return (
    <section className="academy-board intro-board" style={cssVars}>
      <div className="intro-steps">
        {["Landing Page", "Telegram Funnel", "Trading Academy", "Trading Events"].map((label) => (
          <div className="intro-step" key={label}><Check size={13} />{label}</div>
        ))}
      </div>
      <div className="agent-portrait"><span>{agent.agentName.slice(0, 1).toUpperCase()}</span></div>
      <div className="intro-copy">
        <div className="brand-pill">{agent.brand} GROUP</div>
        <h2>{agent.academyName}</h2>
        <p>{agent.promise} Built to turn {agent.audience} into active community members.</p>
      </div>
    </section>
  );
}

function FunnelBoard({ cssVars }) {
  const top = [
    ["Traffic Sources", "Social, YouTube, partners", Users],
    ["Landing Page", "Proof, offer, CTA", Sparkles],
    ["UID Verification", "Simple sign-up path", ShieldCheck],
    ["Onboarding", "Welcome and first task", Bot],
    ["Private Channel", "Lessons, signals, contests", Send]
  ];
  const bottom = [
    ["Education Content", "Beginner lessons"],
    ["Trading Signals", "Regular signal context"],
    ["Contests & Bonuses", "Rewards and campaigns"],
    ["Community", "Chat and retention"]
  ];
  return (
    <section className="academy-panel" style={cssVars}>
      <PanelTitle title="Telegram Funnel" desc="可直接复用为内部方案图或代理招商物料。" />
      <div className="funnel-strip">
        {top.map(([title, desc, Icon]) => (
          <div className="funnel-card" key={title}>
            <Icon size={22} />
            <strong>{title}</strong>
            <span>{desc}</span>
          </div>
        ))}
      </div>
      <div className="funnel-lanes">
        <div className="email-node"><Mail size={24} /><strong>Email Funnel</strong><span>Onboarding emails, recaps, bonus prompts.</span></div>
        <div className="lane-grid">
          {bottom.map(([title, desc]) => <div className="lane-card" key={title}><strong>{title}</strong><span>{desc}</span></div>)}
        </div>
      </div>
      <div className="retention-node"><Award size={24} /><strong>Active Trader / Retention</strong><span>Engaged users, trading activity, long-term retention.</span></div>
    </section>
  );
}

function TelegramPack({ agent, cssVars }) {
  return (
    <section className="academy-panel" style={cssVars}>
      <PanelTitle title="Telegram Channel Pack" desc="频道、验证 Bot、Premium 群三套头图可以批量换代理。" />
      <div className="phone-grid">
        {["Channel", "Verify Bot", "Premium"].map((type) => (
          <div className="telegram-tile" key={type}>
            <div className="telegram-badge"><Send size={26} />TELEGRAM {type.toUpperCase()}</div>
            <div className="phone-shell">
              <div className="phone-top" />
              <div className="profile-dot">{agent.agentName.slice(0, 1).toUpperCase()}</div>
              <strong>{type === "Verify Bot" ? `${agent.agentName} Verify Bot` : agent.academyName}</strong>
              <span>{agent.subscribers} subscribers</span>
              <div className="post-card">{type === "Verify Bot" ? "Start verification" : "Pinned market update"}</div>
              <div className="post-lines" />
              <div className="post-media" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ThumbnailGrid({ agent, cssVars }) {
  return (
    <section className="academy-panel" style={cssVars}>
      <PanelTitle title="YouTube Thumbnail Concepts" desc="适合接视频标题、币种、涨跌幅字段生成图片。" />
      <div className="thumb-grid">
        {thumbnails.map(([title, sub, price], index) => (
          <div className="thumb-card" key={`${title}-${index}`}>
            <div className="live-tag">LIVE</div>
            <div className="thumb-copy"><strong>{title}</strong><span>{sub}</span></div>
            <div className="price-tag">{price}</div>
            <div className="coin-mark">B</div>
            <div className="thumb-person">{agent.agentName.slice(0, 1).toUpperCase()}</div>
            <div className="chart-line" />
          </div>
        ))}
      </div>
    </section>
  );
}

function WeekSchedule({ agent, cssVars }) {
  return (
    <section className="academy-panel" style={cssVars}>
      <PanelTitle title="Weekly Academy Schedule" desc="把 TG 群内容变成用户能感知的学院节奏。" />
      <div className="week-list">
        {week.map((item, index) => {
          const Icon = item.icon;
          return (
            <div className="week-item" key={item.day}>
              <div className="week-day"><span>{item.day}</span><small>Day {index + 1}</small></div>
              <div className="week-content">
                <div><Icon size={20} /><strong>{item.label}</strong></div>
                <p>{item.text}</p>
              </div>
              <div className="week-preview"><MessageCircle size={20} /><strong>{agent.academyName}</strong><span>{item.label} preview</span></div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PanelTitle({ title, desc }) {
  return (
    <div className="panel-title">
      <h2>{title}</h2>
      <p>{desc}</p>
    </div>
  );
}
