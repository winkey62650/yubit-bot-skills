import { notFound } from "next/navigation";
import { getDistributionRepository } from "../../../lib/distribution-repository.mjs";
import { getMarketPublication, weeklyCalendarArticlePath } from "../../../lib/market-publication.mjs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Weekly Market Risk Playbook | YUBIT",
  description: "An evidence-led weekly calendar of the macro events that matter most to digital assets.",
  robots: { index: true, follow: true },
};

const scenarioTone = {
  base: "border-[#d9ddd8] bg-[#f7f8f5]",
  strengthening: "border-[#bad9cc] bg-[#edf7f2]",
  invalidation: "border-[#e2c9c2] bg-[#fbf1ee]",
};

function SectionLabel({ children }) {
  return <p className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-[#477061]">{children}</p>;
}

function formatUtc(value) {
  const normalized = String(value || "");
  return normalized ? `${normalized.slice(0, 10)} · ${normalized.slice(11, 16)} UTC` : "Time pending";
}

function valueOrDash(value) {
  return value === undefined || value === null || String(value).trim() === "" ? "—" : String(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isTextArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isText);
}

function isScenario(value) {
  return isRecord(value) && [value.id, value.label, value.condition, value.implication].every(isText);
}

function isWeeklyEvent(value) {
  return isRecord(value)
    && [value.id, value.title, value.utcTime, value.jurisdiction, value.whyItMatters, value.transmissionPath, value.scenarioMap].every(isText)
    && Number.isInteger(value.rank)
    && value.rank > 0
    && Number.isFinite(Number(value.impactScore))
    && isTextArray(value.affectedAssets);
}

function isWeeklyArticle(article, week) {
  return isRecord(article)
    && article.id === `weekly-calendar:${week}`
    && article.type === "weekly-calendar-analysis"
    && article.version === "market-editorial-v1"
    && article.slug === week
    && [article.publishedAt, article.weekStart, article.weekEnd, article.kicker, article.title, article.coreView, article.disclaimer].every(isText)
    && isRecord(article.marketSetup)
    && [article.marketSetup.label, article.marketSetup.summary, article.marketSetup.observedAt].every(isText)
    && Array.isArray(article.priorityEvents)
    && article.priorityEvents.length > 0
    && article.priorityEvents.every(isWeeklyEvent)
    && Array.isArray(article.impactRankedEvents)
    && article.impactRankedEvents.length > 0
    && article.impactRankedEvents.every(isWeeklyEvent)
    && Array.isArray(article.tierOneAnalysis)
    && article.tierOneAnalysis.length > 0
    && article.tierOneAnalysis.every((event) => isRecord(event)
      && [event.id, event.headline, event.whyItMatters, event.transmissionPath, event.scenarioMap].every(isText)
      && isTextArray(event.affectedAssets))
    && Array.isArray(article.scenarios)
    && article.scenarios.length > 0
    && article.scenarios.every(isScenario)
    && Array.isArray(article.dailyWatchlist)
    && article.dailyWatchlist.length > 0
    && article.dailyWatchlist.every((day) => isRecord(day) && isText(day.date) && isTextArray(day.items));
}

function safeExternalUrl(value) {
  if (!isText(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function ExternalReference({ href, children, className }) {
  const safeHref = safeExternalUrl(href);
  return safeHref
    ? <a className={className} href={safeHref} target="_blank" rel="noreferrer">{children}</a>
    : <span className={className}>{children}</span>;
}

export default async function WeeklyCalendarPage({ params, repository: suppliedRepository }) {
  const resolvedParams = await params;
  const week = resolvedParams?.week;
  try {
    weeklyCalendarArticlePath(week);
  } catch {
    notFound();
  }

  const repository = suppliedRepository ?? await getDistributionRepository();
  const bundle = await getMarketPublication({ repository, product: "weekly-calendar", slug: week });
  if (!bundle || bundle.status === "draft" || !isWeeklyArticle(bundle.article, week)) notFound();
  const article = bundle.article;
  const sources = Array.isArray(article.sources)
    ? article.sources.filter((source) => isRecord(source) && isText(source.label))
    : [];
  const limitations = Array.isArray(article.limitations) ? article.limitations.filter(isText) : [];

  return (
    <main className="min-h-screen bg-[#f1f0eb] text-[#142019]">
      <div className="border-b border-black/10 bg-[#142019] text-[#f6f2e8]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
          <span className="font-mono text-xs font-semibold tracking-[0.24em]">YUBIT / INTELLIGENCE</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#a9bbb2]">Evidence before narrative</span>
        </div>
      </div>

      <article data-content-hash={bundle.contentHash} className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-16">
        <header className="grid gap-8 border-b border-black/15 pb-12 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-16">
          <div>
            <SectionLabel>{article.kicker}</SectionLabel>
            <h1 className="max-w-4xl font-serif text-4xl font-semibold leading-[1.04] tracking-[-0.035em] sm:text-6xl">{article.title}</h1>
          </div>
          <aside className="self-end border-l-2 border-[#4e8f75] pl-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#67746d]">Coverage window</p>
            <p className="mt-2 text-base font-semibold">{article.weekStart} — {article.weekEnd}</p>
            <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-[#67746d]">Published</p>
            <p className="mt-2 text-sm">{formatUtc(article.publishedAt)}</p>
          </aside>
        </header>

        <section className="grid gap-8 border-b border-black/15 py-12 lg:grid-cols-[240px_minmax(0,1fr)]">
          <div><SectionLabel>Core view</SectionLabel></div>
          <p className="font-serif text-2xl leading-9 tracking-[-0.015em] sm:text-3xl sm:leading-10">{article.coreView}</p>
        </section>

        <section className="grid gap-8 border-b border-black/15 py-12 lg:grid-cols-[240px_minmax(0,1fr)]">
          <div><SectionLabel>{article.marketSetup.label}</SectionLabel></div>
          <div>
            <p className="text-lg leading-8 text-[#35423b]">{article.marketSetup.summary}</p>
            <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.16em] text-[#758079]">Observed {formatUtc(article.marketSetup.observedAt)}</p>
          </div>
        </section>

        <section className="border-b border-black/15 py-12">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <SectionLabel>Impact-ranked event table</SectionLabel>
              <h2 className="font-serif text-3xl font-semibold tracking-[-0.02em]">The week at a glance</h2>
            </div>
            <p className="max-w-md text-sm leading-6 text-[#66726b]">Impact scores are editorial prioritization, not forecasts of realized volatility.</p>
          </div>
          <div className="mt-8 overflow-x-auto border-y border-black/15">
            <table className="w-full min-w-[860px] border-collapse text-left">
              <thead>
                <tr className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#67746d]">
                  <th className="py-4 pr-5 font-semibold">Rank</th>
                  <th className="px-5 py-4 font-semibold">Event</th>
                  <th className="px-5 py-4 font-semibold">UTC schedule</th>
                  <th className="px-5 py-4 font-semibold">Forecast</th>
                  <th className="px-5 py-4 font-semibold">Previous</th>
                  <th className="py-4 pl-5 text-right font-semibold">Impact</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {article.impactRankedEvents.map((event) => (
                  <tr key={event.id} className="align-top">
                    <td className="py-5 pr-5 font-serif text-2xl text-[#87958d]">{String(event.rank).padStart(2, "0")}</td>
                    <td className="px-5 py-5">
                      <p className="font-semibold">{event.title}</p>
                      <p className="mt-1 text-xs text-[#6b766f]">{event.jurisdiction}</p>
                    </td>
                    <td className="px-5 py-5 text-sm">{formatUtc(event.utcTime)}</td>
                    <td className="px-5 py-5 text-sm">{valueOrDash(event.values?.forecast)}</td>
                    <td className="px-5 py-5 text-sm">{valueOrDash(event.values?.previous)}</td>
                    <td className="py-5 pl-5 text-right font-mono text-sm font-semibold text-[#477061]">{event.impactScore}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="border-b border-black/15 py-12">
          <SectionLabel>Tier-one analysis</SectionLabel>
          <div className="mt-7 divide-y divide-black/15 border-y border-black/15">
            {article.tierOneAnalysis.map((event, index) => (
              <section key={event.id} className="grid gap-6 py-10 lg:grid-cols-[120px_minmax(0,1fr)]">
                <div className="font-serif text-5xl text-[#94a39b]">{String(index + 1).padStart(2, "0")}</div>
                <div>
                  <h2 className="font-serif text-2xl font-semibold leading-8 sm:text-3xl">{event.headline}</h2>
                  <div className="mt-7 grid gap-6 md:grid-cols-2">
                    <div>
                      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#477061]">Why it matters</p>
                      <p className="mt-2 text-sm leading-7">{event.whyItMatters}</p>
                    </div>
                    <div>
                      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#477061]">Transmission path</p>
                      <p className="mt-2 text-sm leading-7">{event.transmissionPath}</p>
                    </div>
                    <div>
                      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#477061]">Affected assets</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {event.affectedAssets.map((asset) => <span key={asset} className="rounded-full bg-[#e4e9e4] px-3 py-1 font-mono text-[10px] font-semibold">{asset}</span>)}
                      </div>
                    </div>
                    <div className="border-l-2 border-[#559277] pl-4">
                      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#477061]">Scenario map</p>
                      <p className="mt-2 text-sm leading-7">{event.scenarioMap}</p>
                    </div>
                  </div>
                </div>
              </section>
            ))}
          </div>
        </section>

        <section className="border-b border-black/15 py-12">
          <SectionLabel>Scenario framework</SectionLabel>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {article.scenarios.map((scenario) => (
              <div key={scenario.id} className={`border p-6 ${scenarioTone[scenario.id] || scenarioTone.base}`}>
                <h2 className="font-serif text-2xl font-semibold">{scenario.label}</h2>
                <p className="mt-5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#67746d]">Condition</p>
                <p className="mt-2 text-sm leading-6">{scenario.condition}</p>
                <p className="mt-5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#67746d]">Market read</p>
                <p className="mt-2 text-sm leading-6">{scenario.implication}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-b border-black/15 py-12">
          <SectionLabel>Daily watchlist</SectionLabel>
          <div className="mt-6 grid gap-px overflow-hidden border border-black/10 bg-black/10 md:grid-cols-2">
            {article.dailyWatchlist.map((day) => (
              <div key={day.date} className="bg-[#f8f7f2] p-6">
                <h2 className="font-serif text-2xl font-semibold">{day.date}</h2>
                <ul className="mt-4 space-y-3">
                  {day.items.map((item) => <li key={item} className="border-l-2 border-[#8fb3a2] pl-4 text-sm leading-6">{item}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <footer className="grid gap-10 py-10 lg:grid-cols-2">
          <div>
            <SectionLabel>Primary sources</SectionLabel>
            <ol className="space-y-3">
              {sources.map((source, index) => (
                <li key={`${source.url}-${index}`} className="text-sm leading-6">
                  <ExternalReference className="underline decoration-black/30 underline-offset-4 hover:decoration-black" href={source.url}>{index + 1}. {source.label}</ExternalReference>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <SectionLabel>Limitations</SectionLabel>
            <ul className="space-y-3 text-sm leading-6 text-[#68736d]">
              {limitations.map((limitation) => <li key={limitation}>— {limitation}</li>)}
            </ul>
            <p className="mt-7 border-t border-black/10 pt-5 text-xs leading-5 text-[#68736d]">{article.disclaimer}</p>
          </div>
        </footer>
      </article>
    </main>
  );
}
