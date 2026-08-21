import { notFound } from "next/navigation";
import { getDistributionRepository } from "../../../../lib/distribution-repository.mjs";
import { dataUpdateArticlePath, getMarketPublication } from "../../../../lib/market-publication.mjs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Data Update | YUBIT Market Intelligence",
  description: "Verified macro data, editorial inference and measured market confirmation from YUBIT.",
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

function signedPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(2)}%` : valueOrDash(value);
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

function isDataUpdateArticle(article, slug) {
  return isRecord(article)
    && article.id === `data-update:${slug}`
    && article.type === "data-update-analysis"
    && article.version === "market-editorial-v1"
    && article.slug === slug
    && [article.publishedAt, article.kicker, article.title, article.verdict, article.invalidation, article.disclaimer].every(isText)
    && isRecord(article.tierDecision)
    && article.tierDecision.tier === "tier-one"
    && isRecord(article.facts)
    && [article.facts.title, article.facts.jurisdiction, article.facts.releasedAt].every(isText)
    && article.facts.actual !== undefined && article.facts.actual !== null && String(article.facts.actual).trim() !== ""
    && isRecord(article.dataSignal)
    && [article.dataSignal.label, article.dataSignal.summary, article.dataSignal.impact].every(isText)
    && isRecord(article.marketConfirmation)
    && [article.marketConfirmation.label, article.marketConfirmation.summary].every(isText)
    && Array.isArray(article.marketConfirmation.observations)
    && article.marketConfirmation.observations.length > 0
    && article.marketConfirmation.observations.every((observation) => isRecord(observation)
      && [observation.symbol, observation.providerName, observation.sourceUrl].every(isText)
      && Number.isFinite(observation.changePercent))
    && isRecord(article.reactionWindow)
    && [article.reactionWindow.start, article.reactionWindow.end].every(isText)
    && isTextArray(article.reactionWindow.providers)
    && Array.isArray(article.scenarioAnalysis)
    && article.scenarioAnalysis.length > 0
    && article.scenarioAnalysis.every(isScenario)
    && isTextArray(article.watchNext);
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

function VerdictBadge({ value }) {
  const tone = value === "Confirmed"
    ? "bg-[#dff1e8] text-[#176144]"
    : value === "Divergent"
      ? "bg-[#f7e6e1] text-[#8a3e2b]"
      : "bg-[#ecefe9] text-[#52615a]";
  return <span className={`rounded-full px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] ${tone}`}>{value}</span>;
}

export default async function DataUpdatePage({ params, repository: suppliedRepository }) {
  const resolvedParams = await params;
  const release = resolvedParams?.release;
  const date = resolvedParams?.date;
  try {
    dataUpdateArticlePath(release, date);
  } catch {
    notFound();
  }

  const slug = `${release}/${date}`;
  const repository = suppliedRepository ?? await getDistributionRepository();
  const bundle = await getMarketPublication({ repository, product: "data-update", slug });
  if (!bundle || bundle.status === "draft" || !isDataUpdateArticle(bundle.article, slug)) notFound();
  const article = bundle.article;
  const sources = Array.isArray(article.sources)
    ? article.sources.filter((source) => isRecord(source) && isText(source.label))
    : [];
  const limitations = Array.isArray(article.limitations) ? article.limitations.filter(isText) : [];

  const facts = article.facts;
  const factRows = [
    ["Actual", facts.actual],
    ["Forecast", facts.forecast],
    ["Previous", facts.previous],
    ["Surprise", facts.surprise],
  ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "");

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
            <div className="flex flex-wrap items-center gap-3">
              <VerdictBadge value={article.verdict} />
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#67746d]">Tier one</span>
            </div>
            <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.18em] text-[#67746d]">Released</p>
            <p className="mt-2 text-sm font-semibold">{formatUtc(facts.releasedAt)}</p>
            <p className="mt-4 text-sm text-[#5f6b64]">{facts.jurisdiction}</p>
          </aside>
        </header>

        <section className="grid gap-8 border-b border-black/15 py-12 lg:grid-cols-[240px_minmax(0,1fr)]">
          <div><SectionLabel>Verified fact table</SectionLabel></div>
          <div className="overflow-hidden border border-black/10 bg-[#f8f7f2]">
            <div className="border-b border-black/10 px-5 py-4">
              <p className="font-serif text-2xl font-semibold">{facts.title}</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.15em] text-[#67746d]">Official release · {formatUtc(facts.releasedAt)}</p>
            </div>
            <dl className="grid grid-cols-2 divide-x divide-y divide-black/10 md:grid-cols-4">
              {factRows.map(([label, value]) => (
                <div key={label} className="min-w-0 p-5">
                  <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#67746d]">{label}</dt>
                  <dd className="mt-2 break-words font-serif text-2xl font-semibold">{valueOrDash(value)}</dd>
                  {label === "Surprise" && facts.surpriseDirection ? <p className="mt-2 text-xs text-[#5f6b64]">{facts.surpriseDirection}</p> : null}
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="grid gap-px overflow-hidden border-b border-black/15 bg-black/10 py-px lg:grid-cols-2">
          <div className="bg-[#f8f7f2] p-7 sm:p-9">
            <SectionLabel>Data Signal / inference</SectionLabel>
            <div className="mt-5 flex items-center gap-3">
              <span className="rounded-full bg-[#e4e9e4] px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]">{article.dataSignal.impact}</span>
            </div>
            <h2 className="mt-5 font-serif text-2xl font-semibold">{article.dataSignal.label}</h2>
            <p className="mt-4 text-base leading-7 text-[#46534c]">{article.dataSignal.summary}</p>
          </div>
          <div className="bg-[#f8f7f2] p-7 sm:p-9">
            <SectionLabel>Market Confirmation / observation</SectionLabel>
            <div className="mt-5"><VerdictBadge value={article.verdict} /></div>
            <h2 className="mt-5 font-serif text-2xl font-semibold">{article.marketConfirmation.label}</h2>
            <p className="mt-4 text-base leading-7 text-[#46534c]">{article.marketConfirmation.summary}</p>
          </div>
        </section>

        <section className="border-b border-black/15 py-12">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <SectionLabel>Bounded reaction table</SectionLabel>
              <h2 className="font-serif text-3xl font-semibold tracking-[-0.02em]">Measured cross-asset response</h2>
            </div>
            <div className="text-right font-mono text-[10px] uppercase leading-5 tracking-[0.14em] text-[#67746d]">
              <p>{formatUtc(article.reactionWindow.start)}</p>
              <p>to {formatUtc(article.reactionWindow.end)}</p>
              <p className="mt-1">Providers: {article.reactionWindow.providers.join(", ")}</p>
            </div>
          </div>
          <div className="mt-8 overflow-x-auto border-y border-black/15">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#67746d]">
                  <th className="py-4 pr-5 font-semibold">Asset</th>
                  <th className="px-5 py-4 font-semibold">Before</th>
                  <th className="px-5 py-4 font-semibold">After</th>
                  <th className="px-5 py-4 font-semibold">Change</th>
                  <th className="py-4 pl-5 font-semibold">Provider</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {article.marketConfirmation.observations.map((observation) => (
                  <tr key={`${observation.symbol}-${observation.providerName}`}>
                    <td className="py-5 pr-5 font-serif text-xl font-semibold">{observation.symbol}</td>
                    <td className="px-5 py-5 text-sm">{valueOrDash(observation.beforePrice)}</td>
                    <td className="px-5 py-5 text-sm">{valueOrDash(observation.price)}</td>
                    <td className={`px-5 py-5 font-mono text-sm font-semibold ${Number(observation.changePercent) < 0 ? "text-[#9b4d3a]" : "text-[#176144]"}`}>{signedPercent(observation.changePercent)}</td>
                    <td className="py-5 pl-5 text-sm">
                      <ExternalReference className="underline decoration-black/30 underline-offset-4 hover:decoration-black" href={observation.sourceUrl}>{observation.providerName}</ExternalReference>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs leading-5 text-[#68736d]">This window is a bounded observation. It does not, by itself, establish causality.</p>
        </section>

        <section className="border-b border-black/15 py-12">
          <SectionLabel>Scenario analysis</SectionLabel>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {article.scenarioAnalysis.map((scenario) => (
              <div key={scenario.id} className={`border p-6 ${scenarioTone[scenario.id] || scenarioTone.base}`}>
                <h2 className="font-serif text-2xl font-semibold">{scenario.label}</h2>
                <p className="mt-5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#67746d]">Condition</p>
                <p className="mt-2 text-sm leading-6">{scenario.condition}</p>
                <p className="mt-5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#67746d]">Market read</p>
                <p className="mt-2 text-sm leading-6">{scenario.implication}</p>
              </div>
            ))}
          </div>
          <div className="mt-6 border-l-2 border-[#b56a56] bg-[#fbf1ee] px-5 py-4">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8a4a3a]">Invalidation boundary</p>
            <p className="mt-2 text-sm leading-6">{article.invalidation}</p>
          </div>
        </section>

        <section className="border-b border-black/15 py-12">
          <SectionLabel>Watch next</SectionLabel>
          <ol className="mt-6 grid gap-px overflow-hidden border border-black/10 bg-black/10 md:grid-cols-3">
            {article.watchNext.map((item, index) => (
              <li key={item} className="bg-[#f8f7f2] p-6">
                <p className="font-mono text-xs font-semibold text-[#477061]">0{index + 1}</p>
                <p className="mt-5 text-sm leading-6">{item}</p>
              </li>
            ))}
          </ol>
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
