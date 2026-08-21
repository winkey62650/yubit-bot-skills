const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_ATTEMPTS = 3;

const BLS_CPI_URL = "https://www.bls.gov/news.release/cpi.nr0.htm";
const BLS_EMPLOYMENT_URL = "https://www.bls.gov/news.release/empsit.nr0.htm";
const BLS_BACKFILL_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/";
const BEA_RELEASES_URL = "https://www.bea.gov/news/current-releases";
const BEA_ORIGIN = "https://www.bea.gov";
const FED_FOMC_URL = "https://www.federalreserve.gov/newsevents/pressreleases.htm";
const FED_ORIGIN = "https://www.federalreserve.gov";

const BLS_CPI_INDICATORS = new Set(["cpi", "cpi-mom", "core-cpi", "core-cpi-mom"]);
const BLS_EMPLOYMENT_INDICATORS = new Set(["nonfarm-payrolls", "nfp", "payrolls", "unemployment-rate"]);
const BEA_PCE_INDICATORS = new Set(["pce", "pce-mom", "core-pce", "core-pce-mom"]);
const BEA_GDP_INDICATORS = new Set(["gdp"]);
const FOMC_INDICATORS = new Set(["fomc-rate-decision", "fomc-statement"]);

export class OfficialReleaseSchemaError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "OfficialReleaseSchemaError";
    this.code = "OFFICIAL_RELEASE_SCHEMA_INVALID";
    this.retryable = false;
  }
}

class OfficialReleaseFetchError extends Error {
  constructor(message, { code = "OFFICIAL_RELEASE_FETCH_FAILED", status, cause } = {}) {
    super(message, { cause });
    this.name = "OfficialReleaseFetchError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function text(value) {
  return String(value ?? "").trim();
}

function normalizedIndicator(value) {
  return text(value).toLowerCase().replaceAll("_", "-").replace(/\s+/g, "-");
}

function clockValue(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must resolve to a valid date");
  return date;
}

function boundedTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
}

function retryConfig(options = {}) {
  const settings = options.retry && typeof options.retry === "object" ? options.retry : {};
  const requested = Number(settings.attempts ?? options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);
  const attempts = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 5) : DEFAULT_RETRY_ATTEMPTS;
  const delay = Number(settings.delayMs ?? options.retryDelayMs ?? 0);
  return {
    attempts,
    delayMs: Number.isFinite(delay) && delay > 0 ? delay : 0,
    delayImpl: settings.delayImpl ?? options.delayImpl,
  };
}

function decodeHtml(value) {
  return text(value)
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&ndash;|&#8211;|&#x2013;/gi, "–")
    .replace(/&mdash;|&#8212;|&#x2014;/gi, "—")
    .replace(/&minus;|&#8722;|&#x2212;/gi, "−")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");
}

function stripTags(value) {
  return decodeHtml(String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function schema(condition, message) {
  if (!condition) throw new OfficialReleaseSchemaError(message);
}

function capture(html, expression, message) {
  const match = String(html ?? "").match(expression);
  schema(match, message);
  return match;
}

function elementById(html, id, tag = "(?:div|main|section|table)") {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = String(html ?? "");
  const opening = source.match(new RegExp(`<(${tag})\\b[^>]*\\bid=["']${escaped}["'][^>]*>`, "i"));
  schema(opening, `Required official element #${id} is missing`);
  const tagName = opening[1];
  const contentStart = opening.index + opening[0].length;
  const tags = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
  tags.lastIndex = contentStart;
  let depth = 1;
  for (let token = tags.exec(source); token; token = tags.exec(source)) {
    if (token[0].startsWith("</")) depth -= 1;
    else if (!token[0].endsWith("/>")) depth += 1;
    if (depth === 0) return source.slice(contentStart, token.index);
  }
  throw new OfficialReleaseSchemaError(`Required official element #${id} is not closed`);
}

function monthPeriod(html, headingPattern) {
  const heading = stripTags(capture(html, headingPattern, "Official release period heading is missing")[1]);
  const match = heading.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i);
  schema(match, "Official release period is missing");
  return `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${match[2]}`;
}

function releasePeriodFromText(body, label) {
  const match = capture(
    body,
    new RegExp(`${label}\\s*[-–—]\\s*(January|February|March|April|May|June|July|August|September|October|November|December)\\s+(20\\d{2})`, "i"),
    `Official ${label} release period is missing`,
  );
  return `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${match[2]}`;
}

function signedPercentage(verb, rawValue) {
  if (/\bunchanged\b/i.test(verb)) return "0";
  schema(rawValue !== undefined, "Official percentage change value is missing");
  const numeric = String(rawValue).replace("−", "-").replace(/^\+/, "");
  const negative = /^(?:decreased|declined|fell)$/i.test(verb);
  return negative ? `-${numeric.replace(/^-/, "")}` : numeric;
}

function blsReleaseBody(html, expectedHeading) {
  const heading = stripTags(capture(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i, "BLS release heading is missing")[1]);
  schema(heading === expectedHeading, `Unexpected BLS release heading: ${heading}`);
  const pre = capture(
    html,
    /<div\b[^>]*\bclass=["'][^"']*\bnormalnews\b[^"']*["'][^>]*>[\s\S]*?<pre\b[^>]*>([\s\S]*?)<\/pre>/i,
    "BLS official release body is missing",
  )[1];
  return stripTags(pre);
}

function articleAttribute(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(attributes).match(new RegExp(`\\b${escaped}=["']([^"']+)["']`, "i"))?.[1];
}

function beaReleaseArticle(html, sourceUrl, expectedPath, expectedHeading) {
  const articleMatch = capture(html, /<article\b([^>]*)>([\s\S]*?)<\/article>/i, "BEA release article is missing");
  const articlePath = decodeHtml(articleAttribute(articleMatch[1], "about"));
  schema(expectedPath.test(articlePath), "BEA release article path is not the requested national release");
  schema(new URL(sourceUrl).pathname === articlePath, "BEA release article path does not match its stable URL");
  schema(/\bclass=["'][^"']*\brelease-body\b[^"']*["']/i.test(articleMatch[2]), "BEA release body is missing");
  const headings = [...articleMatch[2].matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map((match) => stripTags(match[1]));
  schema(headings.length > 0, "BEA release heading is missing");
  const matchingHeadings = headings.filter((heading) => expectedHeading.test(heading));
  schema(matchingHeadings.length === 1, `Expected one matching BEA release heading, found ${matchingHeadings.length}`);
  const [heading] = matchingHeadings;
  return { html: articleMatch[0], text: stripTags(articleMatch[0]), heading };
}

const MONTHS = Object.freeze({
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
});

function easternReleaseTimestamp(html, defaultHour = 8, defaultMinute = 30) {
  const explicit = String(html).match(/<time\b[^>]*\bdatetime=["']([^"']+)["']/i)?.[1];
  if (explicit) {
    const parsed = new Date(explicit);
    schema(Number.isFinite(parsed.getTime()), "Official release timestamp is invalid");
    return parsed.toISOString();
  }
  const body = stripTags(html);
  const date = body.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(20\d{2})\b/i);
  schema(date, "Official release date is missing");
  const statedTime = body.match(/\b(\d{1,2}):(\d{2})\s*(a\.m\.|p\.m\.)\s*(?:\((ET)\)|(EDT|EST))?/i);
  let hour = statedTime ? Number(statedTime[1]) : defaultHour;
  const minute = statedTime ? Number(statedTime[2]) : defaultMinute;
  if (statedTime?.[3].toLowerCase().startsWith("p") && hour !== 12) hour += 12;
  if (statedTime?.[3].toLowerCase().startsWith("a") && hour === 12) hour = 0;
  const month = MONTHS[date[1].toLowerCase()];
  const year = Number(date[3]);
  const day = Number(date[2]);
  const explicitZone = statedTime?.[5]?.toUpperCase();
  let offsetHours;
  if (explicitZone) {
    offsetHours = explicitZone === "EDT" ? 4 : 5;
  } else {
    const firstSunday = (targetMonth) => 1 + ((7 - new Date(Date.UTC(year, targetMonth, 1)).getUTCDay()) % 7);
    const dstStartDay = firstSunday(2) + 7;
    const dstEndDay = firstSunday(10);
    const afterDstStart = month > 2 || (month === 2 && (day > dstStartDay || (day === dstStartDay && hour >= 2)));
    const beforeDstEnd = month < 10 || (month === 10 && (day < dstEndDay || (day === dstEndDay && hour < 2)));
    offsetHours = afterDstStart && beforeDstEnd ? 4 : 5;
  }
  return new Date(Date.UTC(year, month, day, hour + offsetHours, minute)).toISOString();
}

function officialSource({ id, label, url }) {
  return Object.freeze({ id, label, type: "official", authority: "official", url });
}

function record({ indicator, rawValue, normalizedValue, unit, releasePeriod, retrievedAt, publishedAt, source, value }) {
  return {
    indicator,
    rawValue: String(rawValue),
    normalizedValue,
    value: value ?? `${rawValue}${unit === "%" || unit === "K" ? unit : ""}`,
    unit,
    status: "verified",
    authority: "official",
    sourceId: source.id,
    sourceUrl: source.url,
    retrievedAt,
    publishedAt,
    releasePeriod,
    availabilityRole: "immediate",
    source,
  };
}

function releaseEnvelope({ source, releasePeriod, retrievedAt, publishedAt, records, extra = {} }) {
  schema(Array.isArray(records) && records.length > 0, "Official release has no complete records");
  schema(records.every((item) => item.rawValue && item.unit && item.releasePeriod && item.retrievedAt && item.publishedAt), "Official release provenance is incomplete");
  return {
    source,
    sourceUrl: source.url,
    releasePeriod,
    retrievedAt,
    publishedAt,
    records,
    backfill: source.id.startsWith("bls-") ? {
      availabilityRole: "backfill",
      sourceUrl: BLS_BACKFILL_URL,
      requested: false,
    } : null,
    ...extra,
  };
}

function retryable(error) {
  if (error?.code === "OFFICIAL_RELEASE_SCHEMA_INVALID") return false;
  if (error?.code === "OFFICIAL_RELEASE_TIMEOUT") return true;
  const status = Number(error?.status);
  return !Number.isFinite(status) || status === 408 || status === 429 || status >= 500;
}

async function delay(milliseconds, delayImpl) {
  if (milliseconds <= 0) return;
  if (typeof delayImpl === "function") await delayImpl(milliseconds);
  else await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchAttempt(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new OfficialReleaseFetchError(`Official release request timed out: ${url}`, { code: "OFFICIAL_RELEASE_TIMEOUT" }));
    }, boundedTimeout(timeoutMs));
  });
  try {
    const request = Promise.resolve().then(() => fetchImpl(url, {
      method: "GET",
      headers: { accept: "text/html,application/xhtml+xml" },
      cache: "no-store",
      signal: controller.signal,
    }));
    const response = await Promise.race([request, timeout]);
    if (!response?.ok) {
      throw new OfficialReleaseFetchError(`Official release returned HTTP ${response?.status ?? "unknown"}: ${url}`, { status: response?.status });
    }
    const html = await Promise.race([Promise.resolve(response.text()), timeout]);
    schema(typeof html === "string" && html.trim(), "Official release response is empty");
    return html;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const retry = retryConfig(options);
  let lastError;
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    try {
      return await fetchAttempt(url, { fetchImpl, timeoutMs: options.timeoutMs });
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === retry.attempts) break;
      await delay(retry.delayMs, retry.delayImpl);
    }
  }
  if (lastError?.code === "OFFICIAL_RELEASE_SCHEMA_INVALID") throw lastError;
  throw new OfficialReleaseFetchError(`Failed to fetch official release: ${url}`, {
    status: lastError?.status,
    cause: lastError,
  });
}

function parseBlsCpi(html, retrievedAt) {
  const body = blsReleaseBody(html, "Consumer Price Index Summary");
  const releasePeriod = releasePeriodFromText(body, "CONSUMER PRICE INDEX");
  const publishedAt = easternReleaseTimestamp(body);
  const headlineMonthly = capture(
    body,
    /\bConsumer Price Index for All Urban Consumers\s*\(CPI-U\)\s+(increased|decreased|rose|fell|was unchanged|remained unchanged)(?:\s+([+−-]?\d+(?:\.\d+)?)\s+percent)?\b/i,
    "Official CPI monthly value is missing",
  );
  const headlineAnnual = capture(
    body,
    /\bOver the last 12 months,\s+the all items index\s+(increased|decreased|rose|fell|was unchanged|remained unchanged)(?:\s+([+−-]?\d+(?:\.\d+)?)\s+percent)?\b/i,
    "Official CPI annual value is missing",
  );
  const coreMonthly = capture(
    body,
    /\bThe index for all items less food and energy\s+(increased|decreased|rose|fell|was unchanged|remained unchanged)(?:\s+([+−-]?\d+(?:\.\d+)?)\s+percent)?\b/i,
    "Official core CPI monthly value is missing",
  );
  const coreAnnual = capture(
    body,
    /\bThe all items less food and energy index\s+(increased|decreased|rose|fell|was unchanged|remained unchanged)(?:\s+([+−-]?\d+(?:\.\d+)?)\s+percent)?\s+over the year\b/i,
    "Official core CPI annual value is missing",
  );
  const headline = [signedPercentage(headlineMonthly[1], headlineMonthly[2]), signedPercentage(headlineAnnual[1], headlineAnnual[2])];
  const core = [signedPercentage(coreMonthly[1], coreMonthly[2]), signedPercentage(coreAnnual[1], coreAnnual[2])];
  const source = officialSource({ id: "bls-cpi", label: "U.S. Bureau of Labor Statistics", url: BLS_CPI_URL });
  const create = (indicator, rawValue) => record({
    indicator, rawValue, normalizedValue: Number(rawValue), unit: "%", releasePeriod, retrievedAt, publishedAt, source,
  });
  return releaseEnvelope({
    source, releasePeriod, retrievedAt, publishedAt,
    records: [create("cpi-mom", headline[0]), create("cpi", headline[1]), create("core-cpi-mom", core[0]), create("core-cpi", core[1])],
  });
}

function parseBlsEmployment(html, retrievedAt) {
  const body = blsReleaseBody(html, "Employment Situation Summary");
  const releasePeriod = releasePeriodFromText(body, "THE EMPLOYMENT SITUATION");
  const publishedAt = easternReleaseTimestamp(body);
  const paired = body.match(/\b(?:Both\s+)?(?:total\s+)?nonfarm payroll employment\s*\(\s*([+−-]?\d[\d,]*)\s*\)\s+and\s+the unemployment rate\s*\(\s*([+−-]?\d+(?:\.\d+)?)\s+percent\s*\)/i);
  let signedPayroll;
  let unemployment;
  if (paired) {
    signedPayroll = Number(paired[1].replace("−", "-").replaceAll(",", ""));
    unemployment = paired[2].replace("−", "-").replace(/^\+/, "");
  } else {
    const payroll = capture(
      body,
      /\btotal nonfarm payroll employment\s+(increased|decreased|rose|fell|edged up|edged down)\s+(?:by\s+)?([\d,]+)\b/i,
      "Official payroll value is missing",
    );
    const unemploymentMatch = capture(
      body,
      /\bunemployment rate\s+(?:changed little at|was unchanged at|edged up to|edged down to|rose to|fell to|increased to|decreased to|was)\s+([+−-]?\d+(?:\.\d+)?)\s+percent\b/i,
      "Official unemployment value is missing",
    );
    const payrollValue = Number(payroll[2].replaceAll(",", ""));
    signedPayroll = /^(?:decreased|fell|edged down)$/i.test(payroll[1]) ? -payrollValue : payrollValue;
    unemployment = unemploymentMatch[1].replace("−", "-").replace(/^\+/, "");
  }
  schema(Number.isFinite(signedPayroll) && signedPayroll % 1_000 === 0, "Official payroll value cannot be normalized to thousands");
  const payrollThousands = String(signedPayroll / 1_000);
  const source = officialSource({ id: "bls-employment-situation", label: "U.S. Bureau of Labor Statistics", url: BLS_EMPLOYMENT_URL });
  return releaseEnvelope({
    source, releasePeriod, retrievedAt, publishedAt,
    records: [
      record({ indicator: "nonfarm-payrolls", rawValue: payrollThousands, normalizedValue: signedPayroll, unit: "K", releasePeriod, retrievedAt, publishedAt, source }),
      record({ indicator: "unemployment-rate", rawValue: unemployment, normalizedValue: Number(unemployment), unit: "%", releasePeriod, retrievedAt, publishedAt, source }),
    ],
  });
}

function parseBeaPce(html, retrievedAt, sourceUrl) {
  const article = beaReleaseArticle(
    html,
    sourceUrl,
    /^\/news\/20\d{2}\/personal-income-and-outlays(?:-[a-z]+-20\d{2})$/i,
    /^Personal Income and Outlays,\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}$/i,
  );
  const releasePeriod = monthPeriod(article.html, /<h1\b[^>]*>\s*Personal Income and Outlays\s*,\s*([\s\S]*?)<\/h1>/i);
  const publishedAt = easternReleaseTimestamp(article.html);
  const monthly = capture(
    article.text,
    /\bFrom the preceding month,\s+the PCE price index for\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(increased|decreased|was unchanged|remained unchanged)(?:\s+([+−-]?\d+(?:\.\d+)?)\s+percent)?\s*\.\s*Excluding food and energy,\s+the PCE price index\s+(increased|decreased|was unchanged|was also unchanged|remained unchanged)(?:\s+([+−-]?\d+(?:\.\d+)?)\s+percent)?\b/i,
    "Official PCE monthly values are missing",
  );
  const annual = capture(
    article.text,
    /\bFrom the same month one year ago,\s+the PCE price index for\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(increased|decreased|was unchanged|remained unchanged)(?:\s+([+−-]?\d+(?:\.\d+)?)\s+percent)?\s*\.\s*Excluding food and energy,\s+the PCE price index\s+(increased|decreased|was unchanged|was also unchanged|remained unchanged)(?:\s+([+−-]?\d+(?:\.\d+)?)\s+percent)?(?:\s+from one year ago)?\b/i,
    "Official PCE annual values are missing",
  );
  const periodMonth = releasePeriod.split(" ")[0];
  schema(monthly[1].toLowerCase() === periodMonth.toLowerCase() && annual[1].toLowerCase() === periodMonth.toLowerCase(), "PCE values do not match the release period");
  const headline = [signedPercentage(monthly[2], monthly[3]), signedPercentage(annual[2], annual[3])];
  const core = [signedPercentage(monthly[4], monthly[5]), signedPercentage(annual[4], annual[5])];
  const source = officialSource({ id: "bea-personal-income-outlays", label: "U.S. Bureau of Economic Analysis", url: sourceUrl });
  const create = (indicator, rawValue) => record({
    indicator, rawValue, normalizedValue: Number(rawValue), unit: "%", releasePeriod, retrievedAt, publishedAt, source,
  });
  return releaseEnvelope({
    source, releasePeriod, retrievedAt, publishedAt,
    records: [create("pce-mom", headline[0]), create("pce", headline[1]), create("core-pce-mom", core[0]), create("core-pce", core[1])],
  });
}

function parseBeaGdp(html, retrievedAt, sourceUrl) {
  const article = beaReleaseArticle(
    html,
    sourceUrl,
    /^\/news\/20\d{2}\/gdp-(?:(?:advance|second|third)-estimate-\d(?:st|nd|rd|th)-quarter(?:-[a-z0-9-]+)?|third-estimate-industries-corporate-profits-state-gdp-and-state-personal-income-\d(?:st|nd|rd|th)-quarter-20\d{2})$/i,
    /^GDP \((?:Advance|Second|Third) Estimate\),\s+(?:Industries, Corporate Profits, State GDP, and State Personal Income,\s+)?(?:1st|2nd|3rd|4th) Quarter 20\d{2}$/i,
  );
  const quarter = capture(article.heading, /^GDP \((?:Advance|Second|Third) Estimate\),\s+(?:Industries, Corporate Profits, State GDP, and State Personal Income,\s+)?(1st|2nd|3rd|4th) Quarter (20\d{2})$/i, "GDP release quarter is missing");
  const releasePeriod = `Q${quarter[1][0]} ${quarter[2]}`;
  const publishedAt = easternReleaseTimestamp(article.html);
  const match = capture(article.text, /\breal gross domestic product\s*\(GDP\)\s+(increased|decreased|was unchanged|remained unchanged)(?:\s+at an annual rate of\s+([+−-]?\d+(?:\.\d+)?)\s+percent)?\b/i, "Official headline GDP value is missing");
  const rawValue = signedPercentage(match[1], match[2]);
  const source = officialSource({ id: "bea-gdp", label: "U.S. Bureau of Economic Analysis", url: sourceUrl });
  return releaseEnvelope({
    source, releasePeriod, retrievedAt, publishedAt,
    records: [record({ indicator: "gdp", rawValue, normalizedValue: Number(rawValue), unit: "% annualized", releasePeriod, retrievedAt, publishedAt, source })],
  });
}

function absoluteFederalReserveUrl(href) {
  try {
    const url = new URL(decodeHtml(href), FED_ORIGIN);
    schema(url.origin === FED_ORIGIN && /^\/newsevents\/pressreleases\/monetary\d{8}a\d*\.htm$/.test(url.pathname), "FOMC release URL is not canonical");
    return url.href;
  } catch (error) {
    if (error?.code === "OFFICIAL_RELEASE_SCHEMA_INVALID") throw error;
    throw new OfficialReleaseSchemaError("FOMC release URL is invalid", { cause: error });
  }
}

function anchors(html) {
  return [...String(html ?? "").matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({ href: decodeHtml(match[1]), label: stripTags(match[2]) }));
}

function hrefs(html) {
  return anchors(html).map(({ href }) => href);
}

function releaseUrlFromIndex(html, { origin, pathPattern, textPattern, label, latest = false }) {
  const candidates = [];
  for (const anchor of anchors(html)) {
    try {
      const candidate = new URL(anchor.href, origin);
      if (candidate.origin === origin && pathPattern.test(candidate.pathname) && (!textPattern || textPattern.test(anchor.label))) {
        candidates.push(candidate.href);
      }
    } catch {
      // Ignore unrelated malformed links; the required official link still has to be present.
    }
  }
  if (candidates.length > 0) return latest ? candidates.sort().at(-1) : candidates[0];
  throw new OfficialReleaseSchemaError(`${label} link is missing from the official release index`);
}

function beaReleaseUrl(indexHtml, indicator) {
  const isPce = BEA_PCE_INDICATORS.has(indicator);
  const pathPattern = isPce
    ? /^\/news\/20\d{2}\/personal-income-and-outlays-[a-z]+-20\d{2}$/i
    : /^\/news\/20\d{2}\/gdp-(?:(?:advance|second|third)-estimate-\d(?:st|nd|rd|th)-quarter(?:-[a-z0-9-]+)?|third-estimate-industries-corporate-profits-state-gdp-and-state-personal-income-\d(?:st|nd|rd|th)-quarter-20\d{2})$/i;
  const textPattern = isPce
    ? /^Personal Income and Outlays,\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}$/i
    : /^GDP \((?:Advance|Second|Third) Estimate\),\s+(?:Industries, Corporate Profits, State GDP, and State Personal Income,\s+)?(?:1st|2nd|3rd|4th) Quarter 20\d{2}$/i;
  return releaseUrlFromIndex(indexHtml, {
    origin: BEA_ORIGIN,
    pathPattern,
    textPattern,
    label: isPce ? "BEA Personal Income and Outlays release" : "BEA national quarterly GDP release",
  });
}

function fomcAnnualIndexUrl(releasesHtml) {
  return releaseUrlFromIndex(releasesHtml, {
    origin: FED_ORIGIN,
    pathPattern: /^\/newsevents\/pressreleases\/20\d{2}-press-fomc\.htm$/,
    textPattern: /^20\d{2} FOMC$/,
    label: "Federal Reserve annual FOMC archive",
    latest: true,
  });
}

function fomcStatementUrl(annualIndexHtml) {
  return releaseUrlFromIndex(annualIndexHtml, {
    origin: FED_ORIGIN,
    pathPattern: /^\/newsevents\/pressreleases\/monetary\d{8}a\.htm$/,
    textPattern: /^Federal Reserve issues FOMC statement$/i,
    label: "FOMC statement",
    latest: true,
  });
}

function fractionNumber(value) {
  const candidate = text(value);
  const fraction = candidate.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (fraction) return Number(fraction[1]) + Number(fraction[2]) / Number(fraction[3]);
  const numeric = Number(candidate);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseFomc(html, retrievedAt, statementUrl) {
  const article = elementById(html, "article", "div");
  const title = stripTags(capture(article, /<h3\b[^>]*\bclass=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i, "FOMC statement title is missing")[1]);
  schema(title === "Federal Reserve issues FOMC statement", "Unexpected Federal Reserve release type");
  const implementationHref = hrefs(article).find((href) => {
    try {
      return /^\/newsevents\/pressreleases\/monetary\d{8}a1\.htm$/.test(new URL(href, FED_ORIGIN).pathname);
    } catch {
      return false;
    }
  });
  schema(implementationHref, "FOMC implementation-note link is missing");
  const implementationNoteUrl = absoluteFederalReserveUrl(implementationHref);
  const content = stripTags(article);
  const target = capture(content, /\btarget range for the federal funds rate at\s+(\d+(?:\.\d+)?(?:-\d+\/\d+)?)\s+to\s+(\d+(?:\.\d+)?(?:-\d+\/\d+)?)\s+percent\b/i, "Official FOMC target range is missing");
  const lower = fractionNumber(target[1]);
  const upper = fractionNumber(target[2]);
  schema(lower !== null && upper !== null && lower <= upper, "Official FOMC target range is invalid");
  const publishedAt = easternReleaseTimestamp(article, 14, 0);
  const releasePeriod = publishedAt.slice(0, 10);
  const rawValue = `${lower}-${upper}`;
  const source = officialSource({ id: "federal-reserve-fomc", label: "Federal Reserve", url: statementUrl });
  return releaseEnvelope({
    source, releasePeriod, retrievedAt, publishedAt,
    records: [record({
      indicator: "fomc-rate-decision", rawValue, normalizedValue: { lower, upper }, unit: "% range",
      value: rawValue, releasePeriod, retrievedAt, publishedAt, source,
    })],
    extra: { statementUrl, implementationNoteUrl },
  });
}

export async function fetchBlsOfficialRelease(options = {}) {
  const indicator = normalizedIndicator(options.indicator);
  const retrievedAt = clockValue(options.now).toISOString();
  if (BLS_CPI_INDICATORS.has(indicator)) {
    return parseBlsCpi(await fetchHtml(BLS_CPI_URL, options), retrievedAt);
  }
  if (BLS_EMPLOYMENT_INDICATORS.has(indicator)) {
    return parseBlsEmployment(await fetchHtml(BLS_EMPLOYMENT_URL, options), retrievedAt);
  }
  throw new OfficialReleaseFetchError(`Unsupported BLS indicator: ${indicator || "missing"}`, { code: "OFFICIAL_RELEASE_UNSUPPORTED" });
}

export async function fetchBeaOfficialRelease(options = {}) {
  const indicator = normalizedIndicator(options.indicator);
  const retrievedAt = clockValue(options.now).toISOString();
  if (!BEA_PCE_INDICATORS.has(indicator) && !BEA_GDP_INDICATORS.has(indicator)) {
    throw new OfficialReleaseFetchError(`Unsupported BEA indicator: ${indicator || "missing"}`, { code: "OFFICIAL_RELEASE_UNSUPPORTED" });
  }
  const indexHtml = await fetchHtml(BEA_RELEASES_URL, options);
  const sourceUrl = beaReleaseUrl(indexHtml, indicator);
  const releaseHtml = await fetchHtml(sourceUrl, options);
  if (BEA_PCE_INDICATORS.has(indicator)) {
    return parseBeaPce(releaseHtml, retrievedAt, sourceUrl);
  }
  return parseBeaGdp(releaseHtml, retrievedAt, sourceUrl);
}

export async function fetchFomcOfficialRelease(options = {}) {
  const retrievedAt = clockValue(options.now).toISOString();
  const releasesHtml = await fetchHtml(FED_FOMC_URL, options);
  const annualIndexUrl = fomcAnnualIndexUrl(releasesHtml);
  const indexHtml = await fetchHtml(annualIndexUrl, options);
  const statementUrl = fomcStatementUrl(indexHtml);
  return parseFomc(await fetchHtml(statementUrl, options), retrievedAt, statementUrl);
}

function indicatorForEvent(event = {}) {
  const direct = normalizedIndicator(event.indicator ?? event.indicatorId ?? event.slug);
  const title = text(event.title).toLowerCase();
  let indicator = direct;
  if (!indicator) {
    const rules = [
      ["core-cpi", /\bcore cpi\b/], ["cpi", /\bcpi\b/], ["core-pce", /\bcore pce\b/], ["pce", /\bpce\b/],
      ["nonfarm-payrolls", /\b(?:nonfarm payrolls?|nfp)\b/], ["unemployment-rate", /\bunemployment rate\b/],
      ["fomc-rate-decision", /\b(?:fomc|fed)\b.*\b(?:rate|decision)\b/], ["fomc-statement", /\bfomc\b.*\bstatement\b/],
      ["gdp", /\bgdp\b/],
    ];
    indicator = rules.find(([, expression]) => expression.test(title))?.[0] ?? "";
  }
  if (/\b(?:mom|month[- ]over[- ]month|monthly)\b/i.test(title) && ["cpi", "core-cpi", "pce", "core-pce"].includes(indicator)) {
    indicator = `${indicator}-mom`;
  }
  return indicator;
}

function supportsUnitedStatesEvent(event = {}) {
  const country = event.country ?? event.countryCode ?? event.country_code ?? event.jurisdiction;
  if (country === undefined || country === null) return true;
  const alias = text(country).toLowerCase().replace(/[^a-z]/g, "");
  return new Set(["us", "usa", "unitedstates", "unitedstatesofamerica"]).has(alias);
}

export async function fetchOfficialActual(options = {}) {
  if (!supportsUnitedStatesEvent(options.event)) {
    throw new OfficialReleaseFetchError(`Unsupported official release country: ${text(options.event?.country ?? options.event?.countryCode ?? options.event?.country_code ?? options.event?.jurisdiction) || "missing"}`, {
      code: "OFFICIAL_RELEASE_UNSUPPORTED",
    });
  }
  const indicator = indicatorForEvent(options.event);
  let release;
  if (BLS_CPI_INDICATORS.has(indicator) || BLS_EMPLOYMENT_INDICATORS.has(indicator)) {
    release = await fetchBlsOfficialRelease({ ...options, indicator });
  } else if (BEA_PCE_INDICATORS.has(indicator) || BEA_GDP_INDICATORS.has(indicator)) {
    release = await fetchBeaOfficialRelease({ ...options, indicator });
  } else if (FOMC_INDICATORS.has(indicator)) {
    release = await fetchFomcOfficialRelease(options);
  } else {
    throw new OfficialReleaseFetchError(`Unsupported official release event: ${indicator || "missing"}`, { code: "OFFICIAL_RELEASE_UNSUPPORTED" });
  }
  const selectedIndicator = indicator === "nfp" || indicator === "payrolls" ? "nonfarm-payrolls" : indicator;
  const selected = release.records.find((item) => item.indicator === selectedIndicator)
    ?? (indicator === "fomc-statement" ? { ...release.records[0], indicator: "fomc-statement" } : null);
  schema(selected, `Official release did not contain requested indicator ${indicator}`);
  return { ...selected, release: { source: release.source, sourceUrl: release.sourceUrl, releasePeriod: release.releasePeriod, statementUrl: release.statementUrl, implementationNoteUrl: release.implementationNoteUrl } };
}
