import { reconcileCalendarEvents } from "./market-provenance.mjs";

export const DEFAULT_SOURCE_TIMEOUT_MS = 8_000;

const MAX_GET_ATTEMPTS = 3;
const TRADINGVIEW_CALENDAR_URL = "https://economic-calendar.tradingview.com/events";
const NASDAQ_CALENDAR_URL = "https://api.nasdaq.com/api/calendar/economicevents";
const FEDERAL_RESERVE_CALENDAR_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const BLS_RELEASE_CALENDAR_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
const BEA_RELEASE_SCHEDULE_URL = "https://www.bea.gov/news/schedule";
const BINANCE_API_URL = "https://api.binance.com";
const OKX_API_URL = "https://www.okx.com";
const DXY_API_URL = "https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB";

const DEFAULT_DAILY_FEEDS = Object.freeze([
  { id: "sec", label: "SEC", kind: "official", url: "https://www.sec.gov/news/pressreleases.rss" },
  { id: "cftc", label: "CFTC", kind: "official", url: "https://www.cftc.gov/PressRoom/PressReleases/rss" },
  { id: "federal-reserve", label: "Federal Reserve", kind: "official", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { id: "coindesk", label: "CoinDesk", kind: "industry", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { id: "decrypt", label: "Decrypt", kind: "industry", url: "https://decrypt.co/feed" },
  { id: "cointelegraph", label: "Cointelegraph", kind: "industry", url: "https://cointelegraph.com/rss" },
]);

class SourceTimeoutError extends Error {
  constructor(url, timeoutMs) {
    super(`GET timeout after ${timeoutMs}ms: ${url}`);
    this.name = "SourceTimeoutError";
    this.code = "SOURCE_TIMEOUT";
  }
}

class SourceSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceSchemaError";
    this.code = "SOURCE_SCHEMA";
    this.retryable = true;
  }
}

function validTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SOURCE_TIMEOUT_MS;
}

function isoNow(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function sourceHealth({ id, url, status, checkedAt, lastSuccessAt = null, freshnessSeconds = null, fallbackFrom }) {
  return {
    id,
    url,
    status,
    checkedAt,
    lastSuccessAt,
    freshnessSeconds,
    ...(fallbackFrom ? { fallbackFrom } : {}),
  };
}

async function fetchOnce(url, { fetchImpl, timeoutMs, accept, type }) {
  const controller = new AbortController();
  const timeout = validTimeout(timeoutMs);
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SourceTimeoutError(url, timeout));
    }, timeout);
  });

  try {
    const requestAndBody = Promise.resolve().then(async () => {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response?.ok) {
        const error = new Error(`GET ${url} returned HTTP ${response?.status ?? "unknown"}`);
        error.status = response?.status;
        throw error;
      }
      return type === "json" ? response.json() : response.text();
    });
    return await Promise.race([requestAndBody, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function adapterDeadline(timeoutMs, deadlineMs) {
  const explicit = Number(deadlineMs);
  const budget = Number.isFinite(explicit) && explicit > 0
    ? explicit
    : validTimeout(timeoutMs) * MAX_GET_ATTEMPTS + 100;
  return Date.now() + budget;
}

function retryableGetError(error) {
  if (error?.retryable || error?.code === "SOURCE_TIMEOUT") return true;
  const status = Number(error?.status);
  if (Number.isFinite(status)) return status === 408 || status === 429 || status >= 500;
  return true;
}

async function retryDelay(delayImpl, retryDelayMs, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new SourceTimeoutError("adapter deadline", 0);
  const requested = Number(retryDelayMs);
  const milliseconds = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 0, remaining);
  if (milliseconds === 0) return;
  const wait = typeof delayImpl === "function"
    ? delayImpl(milliseconds)
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
  let timer;
  try {
    await Promise.race([
      Promise.resolve(wait),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new SourceTimeoutError("retry delay deadline", remaining)),
          remaining,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function getWithRetry(url, {
  fetchImpl,
  timeoutMs,
  type,
  deadlineAt = adapterDeadline(timeoutMs),
  retryDelayMs = 0,
  delayImpl,
  validate,
}) {
  let lastError;
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_GET_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    try {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new SourceTimeoutError(url, 0);
      const data = await fetchOnce(url, {
        fetchImpl,
        timeoutMs: Math.min(validTimeout(timeoutMs), remaining),
        type,
        accept: type === "json" ? "application/json" : "application/rss+xml, application/atom+xml, application/xml, text/xml",
      });
      if (validate) validate(data);
      return { data, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!retryableGetError(error) || attempt === MAX_GET_ATTEMPTS) break;
      try {
        await retryDelay(delayImpl, retryDelayMs, deadlineAt);
      } catch (deadlineError) {
        lastError = deadlineError;
        break;
      }
    }
  }
  lastError.attempts ??= attempts;
  throw lastError;
}

function missingValue(value) {
  if (value === null || value === undefined) return true;
  const text = String(value)
    .replace(/&(?:nbsp|#160|#xA0);/gi, " ")
    .replace(/\u00a0/g, " ")
    .trim();
  return !text || /^(?:tbd|n\/?a|na|[-–—]+|null|undefined)$/i.test(text);
}

function normalizedValue(value, unit) {
  if (missingValue(value)) return null;
  const text = String(value).trim();
  const suffix = missingValue(unit) ? "" : String(unit).trim();
  return suffix && !text.endsWith(suffix) ? `${text}${suffix}` : text;
}

function normalizedScheduledAt(value) {
  if (missingValue(value)) return null;
  let date;
  if (typeof value === "number" || /^\d+$/.test(String(value).trim())) {
    const numeric = Number(value);
    date = new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
  } else {
    const text = String(value).trim();
    if (!/(?:T|\s)\d{1,2}:\d{2}/i.test(text)) return null;
    date = new Date(text);
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizedImportance(value) {
  if (missingValue(value)) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const labels = { low: 1, medium: 2, high: 3 };
  return labels[String(value || "").trim().toLowerCase()] ?? null;
}

export function normalizeCalendarEvents(events = []) {
  if (!Array.isArray(events)) return [];
  return events.map((event = {}) => {
    const sourceId = event.id ?? event.eventId ?? event.event_id ?? null;
    const rawDate = event.date ?? event.datetime ?? event.timestamp ?? event.time ?? null;
    const scheduledAt = normalizedScheduledAt(rawDate);
    const unit = missingValue(event.unit) ? null : String(event.unit).trim();
    const period = event.period ?? event.releasePeriod ?? event.referencePeriod ?? event.reference_period;
    return {
      id: sourceId === null ? null : String(sourceId),
      sourceId,
      title: String(event.title ?? event.event ?? event.name ?? "").trim(),
      country: String(event.country ?? event.countryCode ?? event.country_code ?? "").trim() || null,
      importance: normalizedImportance(event.importance ?? event.impact),
      scheduledAt,
      timeLabel: scheduledAt || "TBD",
      rawScheduledAt: rawDate,
      ...(missingValue(period) ? {} : { period: String(period).trim() }),
      unit,
      values: {
        actual: normalizedValue(event.actual, unit),
        forecast: normalizedValue(event.forecast, unit),
        previous: normalizedValue(event.previous, unit),
      },
      rawValues: {
        actual: event.actual ?? null,
        forecast: event.forecast ?? null,
        previous: event.previous ?? null,
        unit: event.unit ?? null,
      },
    };
  });
}

function calendarUrl(from, to) {
  const url = new URL(TRADINGVIEW_CALENDAR_URL);
  if (from !== undefined && from !== null && from !== "") url.searchParams.set("from", isoNow(from));
  if (to !== undefined && to !== null && to !== "") url.searchParams.set("to", isoNow(to));
  return url.toString();
}

function tradingViewEvents(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray(payload.result)) return payload.result;
  if (payload && typeof payload === "object" && Array.isArray(payload.data)) return payload.data;
  throw new SourceSchemaError("Unrecognized TradingView calendar payload schema");
}

export async function fetchTradingViewCalendar({
  from,
  to,
  now,
  fetchImpl = fetch,
  timeoutMs,
  deadlineMs,
  retryDelayMs,
  delayImpl,
} = {}) {
  const url = calendarUrl(from, to);
  const checkedAt = isoNow(now ?? new Date());
  const deadlineAt = adapterDeadline(timeoutMs, deadlineMs);
  try {
    const response = await getWithRetry(url, {
      fetchImpl,
      timeoutMs,
      type: "json",
      deadlineAt,
      retryDelayMs,
      delayImpl,
      validate: tradingViewEvents,
    });
    const payload = tradingViewEvents(response.data);
    const data = normalizeCalendarEvents(payload).map((event) => ({
      ...event,
      source: {
        id: "tradingview-calendar",
        label: "TradingView Economic Calendar",
        url,
      },
    }));
    return {
      data,
      events: data,
      sources: [sourceHealth({
        id: "tradingview-calendar",
        url,
        status: "ok",
        checkedAt,
        lastSuccessAt: checkedAt,
        freshnessSeconds: 0,
      })],
      warnings: [],
    };
  } catch (error) {
    return {
      data: [],
      events: [],
      sources: [sourceHealth({
        id: "tradingview-calendar",
        url,
        status: error?.code === "SOURCE_TIMEOUT" ? "timeout" : "error",
        checkedAt,
      })],
      warnings: [`TradingView calendar unavailable: ${error.message}`],
    };
  }
}

function calendarDates(from, to, now) {
  const start = new Date(from ?? now ?? new Date());
  const end = new Date(to ?? start.getTime() + 24 * 60 * 60 * 1000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const exclusiveEnd = end.getTime() > cursor.getTime() ? end.getTime() : cursor.getTime() + 24 * 60 * 60 * 1000;
  const dates = [];
  while (cursor.getTime() < exclusiveEnd && dates.length < 8) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function nasdaqImportance(title) {
  return /(?:CPI|PCE|PPI|GDP|retail sales|payroll|unemployment|jobless|FOMC|Federal Reserve|interest rate)/i.test(title)
    ? 3
    : 2;
}

function nasdaqRows(payload) {
  const rows = payload?.data?.rows;
  if (!Array.isArray(rows)) throw new SourceSchemaError("Unrecognized Nasdaq economic calendar payload schema");
  return rows;
}

function nasdaqCountry(value) {
  const country = String(value ?? "").trim();
  if (/^(?:United States|USA|U\.S\.)$/i.test(country)) return "US";
  return country || null;
}

export async function fetchNasdaqCalendar({
  from,
  to,
  now,
  fetchImpl = fetch,
  timeoutMs,
  deadlineMs,
  retryDelayMs,
  delayImpl,
} = {}) {
  const checkedAt = isoNow(now ?? new Date());
  const deadlineAt = adapterDeadline(timeoutMs, deadlineMs);
  const dates = calendarDates(from, to, now);
  const outcomes = new Array(dates.length);
  let cursor = 0;
  const loadNextDate = async () => {
    const index = cursor;
    cursor += 1;
    if (index >= dates.length) return;
    const date = dates[index];
    const url = new URL(NASDAQ_CALENDAR_URL);
    url.searchParams.set("date", date);
    try {
      const response = await getWithRetry(url.toString(), {
        fetchImpl,
        timeoutMs,
        type: "json",
        deadlineAt,
        retryDelayMs,
        delayImpl,
        validate: nasdaqRows,
      });
      const events = nasdaqRows(response.data).flatMap((row, rowIndex) => {
        const title = String(row?.eventName ?? row?.event ?? row?.name ?? "").trim();
        const gmt = String(row?.gmt ?? row?.time ?? "").trim();
        const scheduledAt = /^\d{1,2}:\d{2}$/.test(gmt)
          ? new Date(`${date}T${gmt.padStart(5, "0")}:00Z`).toISOString()
          : null;
        const period = row?.period ?? row?.releasePeriod ?? row?.referencePeriod ?? row?.reference_period;
        if (!title || (scheduledAt && !inCalendarRange(scheduledAt, from, to))) return [];
        return [{
          id: `nasdaq:${date}:${gmt || "tbd"}:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || rowIndex}`,
          sourceId: row?.id ?? null,
          title,
          country: nasdaqCountry(row?.country),
          importance: nasdaqImportance(title),
          scheduledAt,
          timeLabel: scheduledAt || "TBD",
          rawScheduledAt: { date, gmt: gmt || null },
          ...(missingValue(period) ? {} : { period: String(period).trim() }),
          unit: null,
          values: {
            actual: normalizedValue(row?.actual, null),
            forecast: normalizedValue(row?.consensus ?? row?.forecast, null),
            previous: normalizedValue(row?.previous, null),
          },
          rawValues: {
            actual: row?.actual ?? null,
            forecast: row?.consensus ?? row?.forecast ?? null,
            previous: row?.previous ?? null,
            unit: null,
          },
          description: String(row?.description ?? "").trim() || null,
          source: {
            id: "nasdaq-economic-calendar",
            label: "Nasdaq Economic Calendar",
            url: url.toString(),
          },
        }];
      });
      outcomes[index] = { status: "ok", events, warning: null };
    } catch (error) {
      outcomes[index] = {
        status: error?.code === "SOURCE_TIMEOUT" ? "timeout" : "error",
        events: [],
        warning: `Nasdaq economic calendar unavailable for ${date}: ${error.message}`,
      };
    }
    await loadNextDate();
  };
  await Promise.all(Array.from(
    { length: Math.min(3, dates.length) },
    () => loadNextDate(),
  ));
  const events = outcomes.flatMap((outcome) => outcome?.events ?? []);
  const warnings = outcomes.flatMap((outcome) => outcome?.warning ? [outcome.warning] : []);
  const successfulRequests = outcomes.filter((outcome) => outcome?.status === "ok").length;
  const timedOutRequests = outcomes.filter((outcome) => outcome?.status === "timeout").length;
  const status = successfulRequests === dates.length && dates.length > 0
    ? "ok"
    : successfulRequests > 0 ? "degraded"
      : timedOutRequests === dates.length && dates.length > 0 ? "timeout" : "error";
  return {
    data: events,
    events,
    sources: [sourceHealth({
      id: "nasdaq-economic-calendar",
      url: NASDAQ_CALENDAR_URL,
      status,
      checkedAt,
      lastSuccessAt: successfulRequests > 0 ? checkedAt : null,
      freshnessSeconds: successfulRequests > 0 ? 0 : null,
      fallbackFrom: "tradingview-calendar",
    })],
    warnings,
  };
}

export function parseFederalReserveCalendar(html) {
  const document = String(html ?? "");
  const seen = new Set();
  const events = [];
  const monthNumbers = new Map([
    ["january", 1], ["february", 2], ["march", 3], ["april", 4],
    ["may", 5], ["june", 6], ["july", 7], ["august", 8],
    ["september", 9], ["october", 10], ["november", 11], ["december", 12],
    ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4],
    ["jun", 6], ["jul", 7], ["aug", 8], ["sep", 9], ["sept", 9],
    ["oct", 10], ["nov", 11], ["dec", 12],
  ]);
  const cleanText = (value) => String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const addEvent = (compactDate, statementPath = null, rawScheduledAt = compactDate) => {
    if (seen.has(compactDate)) return;
    seen.add(compactDate);
    const year = Number(compactDate.slice(0, 4));
    const month = Number(compactDate.slice(4, 6));
    const day = Number(compactDate.slice(6, 8));
    const scheduledAt = zonedDateToIso(`${compactDate}T140000`, "America/New_York");
    if (!scheduledAt || new Date(scheduledAt).getUTCFullYear() !== year) return;
    const date = scheduledAt.slice(0, 10);
    events.push({
      id: `fomc-rate-decision-${date}`,
      sourceId: compactDate,
      title: "FOMC Rate Decision & Statement",
      country: "US",
      importance: 3,
      scheduledAt,
      timeLabel: scheduledAt,
      rawScheduledAt,
      unit: null,
      values: { actual: null, forecast: null, previous: null },
      rawValues: { actual: null, forecast: null, previous: null, unit: null },
      source: {
        id: "federal-reserve-calendar",
        label: "Federal Reserve",
        url: statementPath
          ? new URL(statementPath, "https://www.federalreserve.gov").toString()
          : FEDERAL_RESERVE_CALENDAR_URL,
        authority: "official",
      },
    });
  };

  const yearHeadings = [...document.matchAll(/<a\b[^>]*>\s*(\d{4})\s+FOMC Meetings\s*<\/a>/gi)];
  for (let yearIndex = 0; yearIndex < yearHeadings.length; yearIndex += 1) {
    const year = Number(yearHeadings[yearIndex][1]);
    const sectionStart = yearHeadings[yearIndex].index;
    const sectionEnd = yearHeadings[yearIndex + 1]?.index ?? document.length;
    const section = document.slice(sectionStart, sectionEnd);
    const meetingStarts = [...section.matchAll(/<div\b[^>]*class=["'](?=[^"']*\brow\b)(?=[^"']*\bfomc-meeting\b)[^"']*["'][^>]*>/gi)];
    for (let meetingIndex = 0; meetingIndex < meetingStarts.length; meetingIndex += 1) {
      const block = section.slice(
        meetingStarts[meetingIndex].index,
        meetingStarts[meetingIndex + 1]?.index ?? section.length,
      );
      const monthText = cleanText(block.match(/<div\b[^>]*class=["'][^"']*fomc-meeting__month[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
      const dateText = cleanText(block.match(/<div\b[^>]*class=["'][^"']*fomc-meeting__date[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
      let month = monthNumbers.get(monthText.toLowerCase().split(/\s*\/\s*/)[0]);
      const days = [...dateText.matchAll(/\d{1,2}/g)].map((match) => Number(match[0]));
      if (!month || days.length === 0) continue;
      const decisionDay = days.at(-1);
      if (days.length > 1 && decisionDay < days[0]) month += 1;
      const decisionYear = month > 12 ? year + 1 : year;
      const decisionMonth = month > 12 ? 1 : month;
      const compactDate = `${decisionYear}${String(decisionMonth).padStart(2, "0")}${String(decisionDay).padStart(2, "0")}`;
      const statementPath = block.match(/href=["']([^"']*\/monetarypolicy\/files\/monetary\d{8}a1\.pdf)["']/i)?.[1] ?? null;
      addEvent(compactDate, statementPath, { year, month: monthText, dates: dateText });
    }
  }

  for (const match of document.matchAll(/href=["']([^"']*\/monetarypolicy\/files\/monetary(\d{8})a1\.pdf)["']/gi)) {
    addEvent(match[2], match[1]);
  }
  return events.sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
}

export async function fetchFederalReserveCalendar({
  from,
  to,
  now,
  fetchImpl = fetch,
  timeoutMs,
  deadlineMs,
  retryDelayMs,
  delayImpl,
} = {}) {
  const checkedAt = isoNow(now ?? new Date());
  const fromMs = Date.parse(from ?? "1970-01-01T00:00:00.000Z");
  const toMs = Date.parse(to ?? "9999-12-31T23:59:59.999Z");
  try {
    const response = await getWithRetry(FEDERAL_RESERVE_CALENDAR_URL, {
      fetchImpl,
      timeoutMs,
      type: "text",
      deadlineAt: adapterDeadline(timeoutMs, deadlineMs),
      retryDelayMs,
      delayImpl,
      validate: (html) => {
        const document = String(html ?? "");
        const hasMeetingSchedule = /<a\b[^>]*>\s*\d{4}\s+FOMC Meetings\s*<\/a>/i.test(document);
        const hasOfficialStatement = /href=["'][^"']*\/monetarypolicy\/files\/monetary\d{8}a1\.pdf["']/i.test(document);
        if (!hasMeetingSchedule && !hasOfficialStatement) {
          throw new SourceSchemaError("Unrecognized Federal Reserve calendar payload schema");
        }
        const parsedMeetings = parseFederalReserveCalendar(document).filter((event) => (
          event.rawScheduledAt && typeof event.rawScheduledAt === "object"
        ));
        const yearHeadings = [...document.matchAll(/<a\b[^>]*>\s*\d{4}\s+FOMC Meetings\s*<\/a>/gi)];
        const monthName = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
        const candidateMeetingCount = yearHeadings.reduce((count, heading, index) => {
          const section = document.slice(heading.index + heading[0].length, yearHeadings[index + 1]?.index ?? document.length);
          const containers = [...section.matchAll(/<(?:div|section|article)\b[^>]*class=["']([^"']*)["'][^>]*>/gi)]
            .filter((match) => match[1].split(/\s+/).some((className) => (
              className === "fomc-meeting" || /^meeting-(?:row|card)(?:\b|[-_])/i.test(className)
            )));
          const datedContainers = containers.filter((container, containerIndex) => {
            const block = section.slice(container.index, containers[containerIndex + 1]?.index ?? section.length);
            const visibleText = decodeXmlEntities(block.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
            const explicitPlaceholder = new RegExp(`^(?:(?:${monthName})(?:\\s*\\/\\s*(?:${monthName}))?\\s+)?(?:TBD|TBA|to be (?:announced|determined)|no meetings scheduled)[*\\s]*$`, "i").test(visibleText);
            return !explicitPlaceholder && new RegExp(`\\b(?:${monthName})(?:\\s*\\/\\s*(?:${monthName}))?\\s+\\d{1,2}(?:\\s*[-–]\\s*\\d{1,2})?(?:\\*|\\s*\\(notation vote\\))?\\b`, "i").test(visibleText);
          });
          return count + datedContainers.length;
        }, 0);
        const meetingRows = [...document.matchAll(/<div\b[^>]*class=["'](?=[^"']*\brow\b)(?=[^"']*\bfomc-meeting\b)[^"']*["'][^>]*>/gi)];
        const hasInvalidMeetingRow = meetingRows.some((row, index) => {
          const block = document.slice(row.index, meetingRows[index + 1]?.index ?? document.length);
          const visibleText = decodeXmlEntities(block.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
          const explicitPlaceholder = new RegExp(`^(?:(?:${monthName})(?:\\s*\\/\\s*(?:${monthName}))?\\s+)?(?:TBD|TBA|to be (?:announced|determined)|no meetings scheduled)[*\\s]*$`, "i").test(visibleText);
          const month = decodeXmlEntities(block.match(/<div\b[^>]*class=["'][^"']*fomc-meeting__month[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
            ?.replace(/<[^>]+>/g, " ") ?? "").replace(/\s+/g, " ").trim();
          const date = decodeXmlEntities(block.match(/<div\b[^>]*class=["'][^"']*fomc-meeting__date[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
            ?.replace(/<[^>]+>/g, " ") ?? "").replace(/\s+/g, " ").trim();
          return !explicitPlaceholder && !(new RegExp(`^(?:${monthName})(?:\\s*\\/\\s*(?:${monthName}))?$`, "i").test(month)
            && /^\d{1,2}(?:\s*[-–]\s*\d{1,2})?(?:\*|\s*\(notation vote\))?$/.test(date));
        });
        if (hasInvalidMeetingRow || candidateMeetingCount > parsedMeetings.length) {
          throw new SourceSchemaError("Federal Reserve calendar meeting structure did not match the expected schema");
        }
      },
    });
    const events = parseFederalReserveCalendar(response.data).filter((event) => {
      const value = Date.parse(event.scheduledAt);
      return value >= fromMs && value < toMs;
    });
    return {
      data: events,
      events,
      sources: [sourceHealth({
        id: "federal-reserve-calendar",
        url: FEDERAL_RESERVE_CALENDAR_URL,
        status: "ok",
        checkedAt,
        lastSuccessAt: checkedAt,
        freshnessSeconds: 0,
        fallbackFrom: "nasdaq-economic-calendar",
      })],
      warnings: [],
    };
  } catch (error) {
    return {
      data: [],
      events: [],
      sources: [sourceHealth({
        id: "federal-reserve-calendar",
        url: FEDERAL_RESERVE_CALENDAR_URL,
        status: error?.code === "SOURCE_TIMEOUT" ? "timeout" : "error",
        checkedAt,
        fallbackFrom: "nasdaq-economic-calendar",
      })],
      warnings: [`Federal Reserve calendar unavailable: ${error.message}`],
    };
  }
}

function unfoldIcs(value) {
  return String(value ?? "").replace(/\r?\n[ \t]/g, "");
}

function icsProperty(block, name) {
  const match = String(block).match(new RegExp(`^${name}(?:;([^:]+))?:(.*)$`, "mi"));
  return match ? { parameters: match[1] ?? "", value: match[2].trim() } : null;
}

function zonedDateToIso(compact, timeZone) {
  const match = String(compact).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/);
  if (!match) return null;
  const desired = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6] ?? 0),
  );
  let candidate = desired;
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(({ type, value }) => [type, value]));
      const represented = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second),
      );
      candidate += desired - represented;
    }
    return new Date(candidate).toISOString();
  } catch {
    return null;
  }
}

function icsDate(property) {
  const raw = property?.value;
  if (!raw || /^\d{8}$/.test(raw)) return null;
  if (/^\d{8}T\d{4}(?:\d{2})?Z$/.test(raw)) {
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?Z$/);
    return new Date(Date.UTC(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]), Number(match[6] ?? 0),
    )).toISOString();
  }
  const zone = property.parameters.match(/(?:^|;)TZID=([^;]+)/i)?.[1];
  return zone ? zonedDateToIso(raw, zone) : null;
}

function officialScheduleDefinitions(title, provider) {
  const text = String(title ?? "");
  if (provider === "bls") {
    if (/consumer price index|\bCPI\b/i.test(text)) return [
      { key: "cpi", title: "US CPI" },
      { key: "core-cpi", title: "US Core CPI" },
    ];
    if (/employment situation/i.test(text)) return [
      { key: "nonfarm-payrolls", title: "US Nonfarm Payrolls" },
      { key: "unemployment-rate", title: "US Unemployment Rate" },
    ];
    return [];
  }
  if (/gross domestic product|\bGDP\b/i.test(text)) return [{ key: "gdp", title: "US GDP" }];
  if (/personal income and outlays|personal consumption expenditures|\bPCE\b/i.test(text)) return [
    { key: "pce", title: "US PCE" },
    { key: "core-pce", title: "US Core PCE" },
  ];
  return [];
}

function inCalendarRange(scheduledAt, from, to) {
  const value = Date.parse(scheduledAt);
  const fromMs = Date.parse(from ?? "1970-01-01T00:00:00.000Z");
  const toMs = Date.parse(to ?? "9999-12-31T23:59:59.999Z");
  return Number.isFinite(value) && value >= fromMs && value < toMs;
}

function parseBlsReleaseCalendar(ics, { from, to, checkedAt }) {
  return [...unfoldIcs(ics).matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)\r?\nEND:VEVENT/gi)].flatMap((match, index) => {
    const summary = icsProperty(match[1], "SUMMARY")?.value ?? "";
    const scheduledAt = icsDate(icsProperty(match[1], "DTSTART"));
    if (!scheduledAt || !inCalendarRange(scheduledAt, from, to)) return [];
    const publishedAt = icsDate(icsProperty(match[1], "DTSTAMP")) ?? checkedAt;
    return officialScheduleDefinitions(summary, "bls").map(({ key, title }) => ({
      id: `${key}:US:${scheduledAt.slice(0, 10)}`,
      sourceId: icsProperty(match[1], "UID")?.value ?? `bls-${index}`,
      title,
      country: "US",
      importance: 3,
      scheduledAt,
      rawScheduledAt: icsProperty(match[1], "DTSTART")?.value ?? scheduledAt,
      values: { actual: null, forecast: null, previous: null },
      rawValues: { actual: null, forecast: null, previous: null, unit: null },
      retrievedAt: checkedAt,
      publishedAt,
      source: { id: "bls-release-calendar", label: "U.S. Bureau of Labor Statistics", url: BLS_RELEASE_CALENDAR_URL, authority: "official" },
    }));
  });
}

async function fetchBlsReleaseCalendar(options = {}) {
  const { from, to, now, fetchImpl = fetch, timeoutMs, deadlineMs, retryDelayMs, delayImpl } = options;
  const checkedAt = isoNow(now ?? new Date());
  try {
    const response = await getWithRetry(BLS_RELEASE_CALENDAR_URL, {
      fetchImpl, timeoutMs, type: "text", deadlineAt: adapterDeadline(timeoutMs, deadlineMs), retryDelayMs, delayImpl,
      validate: (ics) => {
        if (!/BEGIN:VCALENDAR/i.test(String(ics ?? ""))) throw new SourceSchemaError("Unrecognized BLS release calendar payload schema");
      },
    });
    const events = parseBlsReleaseCalendar(response.data, { from, to, checkedAt });
    return {
      data: events, events,
      sources: [sourceHealth({ id: "bls-release-calendar", url: BLS_RELEASE_CALENDAR_URL, status: "ok", checkedAt, lastSuccessAt: checkedAt, freshnessSeconds: 0 })],
      warnings: [],
    };
  } catch (error) {
    return {
      data: [], events: [],
      sources: [sourceHealth({ id: "bls-release-calendar", url: BLS_RELEASE_CALENDAR_URL, status: error?.code === "SOURCE_TIMEOUT" ? "timeout" : "error", checkedAt })],
      warnings: [`BLS release calendar unavailable: ${error.message}`],
    };
  }
}

function parseBeaReleaseSchedule(html, { from, to, checkedAt }) {
  const document = String(html ?? "");
  const table = document.match(/<table\b[^>]*id=["']release-schedule-table["'][^>]*>([\s\S]*?)<\/table>/i)?.[1] ?? "";
  const year = Number(table.match(/\bYear\s+(\d{4})\b/i)?.[1]);
  const monthNumbers = new Map([
    ["january", 1], ["february", 2], ["march", 3], ["april", 4],
    ["may", 5], ["june", 6], ["july", 7], ["august", 8],
    ["september", 9], ["october", 10], ["november", 11], ["december", 12],
  ]);
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  return rows.flatMap((match, index) => {
    const dateText = decodeXmlEntities(match[1].match(/class=["'][^"']*\brelease-date\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]
      ?.replace(/<[^>]+>/g, " ") ?? "").replace(/\s+/g, " ").trim();
    const clockText = decodeXmlEntities(match[1].match(/class=["'][^"']*\btext-muted\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]
      ?.replace(/<[^>]+>/g, " ") ?? "").replace(/\s+/g, " ").trim();
    const title = decodeXmlEntities(match[1].match(/class=["'][^"']*\brelease-title\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)?.[1]
      ?.replace(/<[^>]+>/g, " ") ?? "").replace(/\s+/g, " ").trim();
    const dateMatch = dateText.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
    const clockMatch = clockText.replace(/\./g, "").match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
    const month = monthNumbers.get(dateMatch?.[1]?.toLowerCase());
    let hour = Number(clockMatch?.[1]);
    if (clockMatch?.[3]?.toUpperCase() === "PM" && hour < 12) hour += 12;
    if (clockMatch?.[3]?.toUpperCase() === "AM" && hour === 12) hour = 0;
    const compact = Number.isInteger(year) && month && dateMatch && clockMatch
      ? `${year}${String(month).padStart(2, "0")}${dateMatch[2].padStart(2, "0")}T${String(hour).padStart(2, "0")}${clockMatch[2]}00`
      : null;
    const scheduledAt = compact ? zonedDateToIso(compact, "America/New_York") : null;
    if (!scheduledAt || !inCalendarRange(scheduledAt, from, to)) return [];
    return officialScheduleDefinitions(title, "bea").map(({ key, title: normalizedTitle }) => ({
      id: `${key}:US:${scheduledAt.slice(0, 10)}`,
      sourceId: `bea-${index}`,
      title: normalizedTitle,
      country: "US",
      importance: 3,
      scheduledAt,
      rawScheduledAt: { date: `${year}-${String(month).padStart(2, "0")}-${dateMatch[2].padStart(2, "0")}`, time: clockText, timeZone: "America/New_York" },
      period: calendarReleasePeriod(title),
      values: { actual: null, forecast: null, previous: null },
      rawValues: { actual: null, forecast: null, previous: null, unit: null },
      retrievedAt: checkedAt,
      publishedAt: checkedAt,
      source: { id: "bea-release-schedule", label: "U.S. Bureau of Economic Analysis", url: BEA_RELEASE_SCHEDULE_URL, authority: "official" },
    }));
  });
}

async function fetchBeaReleaseSchedule(options = {}) {
  const { from, to, now, fetchImpl = fetch, timeoutMs, deadlineMs, retryDelayMs, delayImpl } = options;
  const checkedAt = isoNow(now ?? new Date());
  try {
    const response = await getWithRetry(BEA_RELEASE_SCHEDULE_URL, {
      fetchImpl, timeoutMs, type: "text", deadlineAt: adapterDeadline(timeoutMs, deadlineMs), retryDelayMs, delayImpl,
      validate: (html) => {
        const document = String(html ?? "");
        const table = document.match(/<table\b[^>]*id=["']release-schedule-table["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
        if (!table || !/<thead\b/i.test(table) || !/<tbody\b/i.test(table) || !/\bYear\s+\d{4}\b/i.test(table)) {
          throw new SourceSchemaError("Unrecognized BEA release schedule payload schema");
        }
        const body = table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
        const invalidRow = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].some((match) => {
          const row = match[1];
          const visibleText = decodeXmlEntities(row.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
          if (!visibleText || /^(?:TBD|TBA|to be (?:announced|determined)|no (?:scheduled )?releases|none|n\/?a)$/i.test(visibleText)) return false;
          const scheduleText = decodeXmlEntities(row.match(/<td\b[^>]*class=["'][^"']*\bscheduled-date\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)?.[1]
            ?.replace(/<[^>]+>/g, " ") ?? "").replace(/\s+/g, " ").trim();
          const dateText = decodeXmlEntities(row.match(/class=["'][^"']*\brelease-date\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]
            ?.replace(/<[^>]+>/g, " ") ?? "").replace(/\s+/g, " ").trim();
          const clockText = decodeXmlEntities(row.match(/class=["'][^"']*\btext-muted\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]
            ?.replace(/<[^>]+>/g, " ") ?? "").replace(/\s+/g, " ").trim();
          const title = decodeXmlEntities(row.match(/class=["'][^"']*\brelease-title\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)?.[1]
            ?.replace(/<[^>]+>/g, " ") ?? "").replace(/\s+/g, " ").trim();
          if (/^(?:TBD|TBA|to be (?:announced|determined))(?:\s+\d{4})?$/i.test(scheduleText)) return !title;
          return !/^[A-Za-z]+\s+\d{1,2}$/.test(dateText)
            || !/^\d{1,2}:\d{2}\s*[AP]M$/i.test(clockText.replace(/\./g, ""))
            || !title;
        });
        if (invalidRow) {
          throw new SourceSchemaError("BEA release schedule rows did not match the expected schema");
        }
      },
    });
    const events = parseBeaReleaseSchedule(response.data, { from, to, checkedAt });
    return {
      data: events, events,
      sources: [sourceHealth({ id: "bea-release-schedule", url: BEA_RELEASE_SCHEDULE_URL, status: "ok", checkedAt, lastSuccessAt: checkedAt, freshnessSeconds: 0 })],
      warnings: [],
    };
  } catch (error) {
    return {
      data: [], events: [],
      sources: [sourceHealth({ id: "bea-release-schedule", url: BEA_RELEASE_SCHEDULE_URL, status: error?.code === "SOURCE_TIMEOUT" ? "timeout" : "error", checkedAt })],
      warnings: [`BEA release schedule unavailable: ${error.message}`],
    };
  }
}

function canonicalCalendarBaseKey(event) {
  const title = String(event?.title ?? "");
  if (/core.*(?:consumer price|\bCPI\b)|(?:consumer price|\bCPI\b).*core/i.test(title)) return "core-cpi";
  if (/consumer price|\bCPI\b/i.test(title)) return "cpi";
  if (/core.*(?:personal consumption|\bPCE\b)|(?:personal consumption|\bPCE\b).*core/i.test(title)) return "core-pce";
  if (/personal income and outlays|personal consumption|\bPCE\b/i.test(title)) return "pce";
  if (/nonfarm|payroll|employment situation/i.test(title)) return "nonfarm-payrolls";
  if (/unemployment rate/i.test(title)) return "unemployment-rate";
  if (/FOMC|Federal Reserve.*(?:decision|statement)|rate decision/i.test(title)) return "fomc-rate-decision";
  if (/gross domestic product|\bGDP\b/i.test(title)) return "gdp";
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || String(event?.id ?? "event");
}

function calendarSeriesDimension(title) {
  const text = String(title ?? "");
  const dimensions = [];
  if (/annuali[sz]ed|annual\s+rate/i.test(text)) dimensions.push("annualized");
  if (/\bQoQ\b|quarter[- ]over[- ]quarter|quarterly/i.test(text)) dimensions.push("qoq");
  if (/\bYoY\b|year[- ]over[- ]year|yearly/i.test(text)) dimensions.push("yoy");
  if (/\bMoM\b|month[- ]over[- ]month|monthly/i.test(text)) dimensions.push("mom");
  return dimensions.join("-");
}

function canonicalCalendarIdentity(event) {
  const baseKey = canonicalCalendarBaseKey(event);
  const dimension = calendarSeriesDimension(event?.title);
  const seriesKey = dimension ? `${baseKey}-${dimension}` : baseKey;
  const component = baseKey.startsWith("core-") ? "core" : "headline";
  const releaseKey = baseKey.replace(/^core-/, "");
  return { baseKey, component, releaseKey, seriesKey };
}

function calendarReleasePeriod(value) {
  const text = String(value ?? "");
  const canonical = text.match(/^\s*(\d{4})-(Q[1-4]|0[1-9]|1[0-2])\s*$/i);
  if (canonical) return `${canonical[1]}-${canonical[2].toUpperCase()}`;
  const quarter = text.match(/(?:\bQ([1-4])\b|\b([1-4])(?:st|nd|rd|th)?\s+Quarter)\D*(\d{4})/i);
  if (quarter) return `${quarter[3]}-Q${quarter[1] ?? quarter[2]}`;
  const months = new Map([
    ["january", "01"], ["february", "02"], ["march", "03"], ["april", "04"],
    ["may", "05"], ["june", "06"], ["july", "07"], ["august", "08"],
    ["september", "09"], ["october", "10"], ["november", "11"], ["december", "12"],
  ]);
  const month = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  return month ? `${month[2]}-${months.get(month[1].toLowerCase())}` : null;
}

function calendarCandidate(event, value, checkedAt, authority = "auxiliary") {
  const rawValue = event.rawScheduledAt ?? value;
  return {
    value,
    rawValue: rawValue && typeof rawValue === "object" ? JSON.stringify(rawValue) : rawValue,
    status: "verified",
    authority,
    sourceId: event.source?.id,
    sourceUrl: event.source?.url,
    retrievedAt: event.retrievedAt ?? checkedAt,
    publishedAt: event.publishedAt ?? event.retrievedAt ?? checkedAt,
  };
}

function valueCandidates(events, key, checkedAt) {
  return events.flatMap((event) => {
    const value = event.values?.[key];
    if (missingValue(value)) return [];
    return [{
      value,
      rawValue: event.rawValues?.[key] ?? value,
      unit: event.unit ?? event.rawValues?.unit ?? null,
      status: "verified",
      authority: "auxiliary",
      sourceId: event.source?.id,
      sourceUrl: event.source?.url,
      retrievedAt: event.retrievedAt ?? checkedAt,
      publishedAt: event.publishedAt ?? event.retrievedAt ?? checkedAt,
    }];
  });
}

const CALENDAR_COUNTRY_ALIASES = new Map([
  ["US", "US"],
  ["USA", "US"],
  ["UNITEDSTATES", "US"],
  ["UNITEDSTATESOFAMERICA", "US"],
]);

function canonicalCalendarCountry(value) {
  const country = String(value ?? "").trim();
  if (!country) return "UNKNOWN";
  const aliasKey = country.toUpperCase().replace(/[.\s_-]+/g, "");
  return CALENDAR_COUNTRY_ALIASES.get(aliasKey) ?? country;
}

function structuredRawDate(value) {
  if (typeof value === "string") {
    const date = value.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  }
  if (!value || typeof value !== "object") return null;
  const date = String(value.date ?? value.day ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function stableCalendarHash(value) {
  let hash = 2_166_136_261;
  for (const character of String(value ?? "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function stableCalendarEventToken(event, identity, country) {
  const sourceIdentity = event?.id ?? event?.sourceId;
  if (!missingValue(sourceIdentity)) {
    return `source-${stableCalendarHash(`${event?.source?.id ?? "source"}\u0000${sourceIdentity}`)}`;
  }
  return `fingerprint-${stableCalendarHash(JSON.stringify({
    source: event?.source?.id ?? null,
    series: identity.seriesKey,
    country,
    period: eventReleasePeriod(event),
  }))}`;
}

function eventReleasePeriod(event) {
  return calendarReleasePeriod(
    event?.period ?? event?.releasePeriod ?? event?.referencePeriod ?? event?.rawPeriod ?? event?.title,
  );
}

function calendarDistance(left, right) {
  const leftMs = Date.parse(left?.scheduledAt);
  const rightMs = Date.parse(right?.scheduledAt);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) ? Math.abs(leftMs - rightMs) : Number.POSITIVE_INFINITY;
}

function calendarEventDate(event) {
  const rawDate = structuredRawDate(event?.rawScheduledAt);
  if (rawDate) return rawDate;
  const scheduledAt = String(event?.scheduledAt ?? "");
  return /^\d{4}-\d{2}-\d{2}T/.test(scheduledAt) ? scheduledAt.slice(0, 10) : null;
}

function mergeCalendarEvents(events, checkedAt) {
  const groups = [];
  const auxiliary = events.filter((event) => event.source?.authority !== "official");
  const official = events.filter((event) => event.source?.authority === "official");
  const addGroup = (event, identity, country, period, occurrence) => {
    const group = { ...identity, country, period, occurrence, events: [event] };
    groups.push(group);
    return group;
  };

  for (const event of auxiliary) {
    const identity = canonicalCalendarIdentity(event);
    const country = canonicalCalendarCountry(event.country);
    const period = eventReleasePeriod(event);
    const eventDate = calendarEventDate(event);
    const occurrence = period ?? (eventDate ? `date-${eventDate}` : null);
    const matching = groups.find((group) => {
      const sameDate = Boolean(eventDate) && group.events.some((candidate) => calendarEventDate(candidate) === eventDate);
      const sameOccurrence = occurrence ? group.occurrence === occurrence : !group.occurrence;
      return group.seriesKey === identity.seriesKey
        && group.country === country
        && (!period || !group.period || group.period === period)
        && (sameDate || sameOccurrence)
        && (sameDate || !event.scheduledAt || calendarDistance(group.events[0], event) <= 48 * 60 * 60 * 1000);
    });
    if (matching) {
      matching.events.push(event);
      matching.period ??= period;
    } else addGroup(
      event,
      identity,
      country,
      period,
      occurrence ?? (event.scheduledAt ? null : `event-${stableCalendarEventToken(event, identity, country)}`),
    );
  }

  for (const event of official) {
    const identity = canonicalCalendarIdentity(event);
    const country = canonicalCalendarCountry(event.country);
    const period = eventReleasePeriod(event);
    const eventDate = calendarEventDate(event);
    const candidates = groups.filter((group) => (
      group.releaseKey === identity.releaseKey
      && group.component === identity.component
      && group.country === country
      && (!period || !group.period || group.period === period)
      && (
        (period && group.period === period)
        || (eventDate && group.events.some((candidate) => calendarEventDate(candidate) === eventDate))
        || group.events.some((candidate) => calendarDistance(candidate, event) <= 4 * 24 * 60 * 60 * 1000)
      )
    ));
    const closestBySeries = new Map();
    for (const group of candidates) {
      const distance = Math.min(...group.events.map((candidate) => calendarDistance(candidate, event)));
      const current = closestBySeries.get(group.seriesKey);
      if (!current || distance < current.distance) closestBySeries.set(group.seriesKey, { group, distance });
    }
    if (closestBySeries.size > 0) {
      for (const { group } of closestBySeries.values()) group.events.push(event);
    } else {
      addGroup(event, identity, country, period, period ?? `event-${stableCalendarEventToken(event, identity, country)}`);
    }
  }

  return groups.map((group) => {
    const preferred = group.events.find((event) => event.source?.authority === "official") ?? group.events[0];
    const titled = group.events.find((event) => event.source?.authority !== "official") ?? preferred;
    const identityDate = preferred.scheduledAt?.slice(0, 10)
      ?? structuredRawDate(preferred.rawScheduledAt)
      ?? group.period
      ?? group.occurrence
      ?? stableCalendarEventToken(preferred, group, group.country);
    return {
      ...preferred,
      id: `${group.seriesKey}:${group.country}:${identityDate}`,
      title: titled.title,
      country: group.country,
      scheduledAt: undefined,
      timeLabel: undefined,
      scheduledAtSources: group.events.flatMap((event) => event.scheduledAt ? [calendarCandidate(
        event,
        event.scheduledAt,
        checkedAt,
        event.source?.authority === "official" ? "official" : "auxiliary",
      )] : []),
      actualSources: valueCandidates(group.events, "actual", checkedAt),
      forecastSources: valueCandidates(group.events, "forecast", checkedAt),
      previousSources: valueCandidates(group.events, "previous", checkedAt),
    };
  });
}

export async function fetchMarketCalendar(options = {}) {
  const checkedAt = isoNow(options.now ?? new Date());
  const results = await Promise.all([
    fetchTradingViewCalendar(options),
    fetchNasdaqCalendar(options),
    fetchFederalReserveCalendar(options),
    fetchBlsReleaseCalendar(options),
    fetchBeaReleaseSchedule(options),
  ]);
  const merged = mergeCalendarEvents(results.flatMap((result) => result.events), checkedAt);
  const reconciled = reconcileCalendarEvents(merged);
  const events = reconciled.events.map((event) => ({
    ...event,
    timeLabel: event.schedule.status === "verified" ? event.scheduledAt : "Time under verification",
  }));
  return {
    data: events,
    events,
    sources: results.flatMap((result) => result.sources),
    warnings: results.flatMap((result) => result.warnings),
    checkedAt,
    reconciliation: reconciled.reconciliation,
  };
}

function decodeXmlEntities(value) {
  let result = String(value ?? "");
  for (let pass = 0; pass < 2; pass += 1) {
    const decoded = result.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
      const lowered = code.toLowerCase();
      if (lowered === "amp") return "&";
      if (lowered === "lt") return "<";
      if (lowered === "gt") return ">";
      if (lowered === "quot") return '"';
      if (lowered === "apos") return "'";
      const numeric = lowered.startsWith("#x")
        ? Number.parseInt(lowered.slice(2), 16)
        : Number.parseInt(lowered.slice(1), 10);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity;
    });
    if (decoded === result) break;
    result = decoded;
  }
  return result;
}

function cleanXmlText(value) {
  const withoutCdata = String(value ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/i, "$1");
  return decodeXmlEntities(withoutCdata.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function xmlTag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match?.[1] ?? "";
}

function attributeValue(attributes, attribute) {
  const match = String(attributes ?? "").match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match?.[2] ?? "";
}

function validateFeedXml(xml) {
  const document = String(xml ?? "").trim();
  const withoutPreamble = document
    .replace(/^<\?xml[\s\S]*?\?>\s*/i, "")
    .replace(/^(?:<!--[\s\S]*?-->\s*)*/, "");
  const root = withoutPreamble.match(/^<(rss|feed)\b[^>]*>/i)?.[1]?.toLowerCase();
  if (!root) throw new SourceSchemaError("Unrecognized RSS/Atom feed root");

  const stack = [];
  const structuralXml = document
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const tags = structuralXml.match(/<[^>]+>/g) ?? [];
  for (const tag of tags) {
    if (/^<\?|^<!/.test(tag)) continue;
    const closing = tag.match(/^<\/\s*([\w:.-]+)\s*>$/);
    if (closing) {
      if (stack.pop()?.toLowerCase() !== closing[1].toLowerCase()) {
        throw new SourceSchemaError("Malformed RSS/Atom XML structure");
      }
      continue;
    }
    const opening = tag.match(/^<\s*([\w:.-]+)\b/);
    if (opening && !/\/\s*>$/.test(tag)) stack.push(opening[1]);
  }
  if (stack.length > 0) throw new SourceSchemaError("Malformed RSS/Atom XML structure");
  if (root === "rss" && !/<channel\b[^>]*>[\s\S]*<\/channel>/i.test(document)) {
    throw new SourceSchemaError("RSS feed is missing a channel");
  }
  return root;
}

function feedItemLink(block) {
  const candidates = [...block.matchAll(/<link\b([^>]*)>/gi)].map((match) => {
    const rel = attributeValue(match[1], "rel").trim().toLowerCase();
    const href = decodeXmlEntities(attributeValue(match[1], "href")).trim();
    return { rel, href };
  }).filter((candidate) => candidate.href && !["self", "enclosure"].includes(candidate.rel));
  const alternate = candidates.find((candidate) => candidate.rel === "alternate");
  const withoutRel = candidates.find((candidate) => !candidate.rel);
  return alternate?.href || withoutRel?.href || cleanXmlText(xmlTag(block, "link"));
}

function normalizedPublishedAt(value) {
  const raw = cleanXmlText(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizedFeedSource(source = {}) {
  const id = String(source.id ?? source.label ?? source.name ?? "rss").trim() || "rss";
  return {
    id,
    label: String(source.label ?? source.name ?? id).trim() || id,
    url: String(source.url ?? "").trim(),
  };
}

export function parseRssFeed(xml, source) {
  validateFeedXml(xml);
  const sourceRecord = normalizedFeedSource(source);
  const blocks = String(xml ?? "").match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  return blocks.map((block) => {
    const sourceId = cleanXmlText(xmlTag(block, "guid") || xmlTag(block, "id")) || null;
    const rawCategories = [
      ...block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi),
    ].map((match) => cleanXmlText(match[1])).filter(Boolean);
    const attributeCategories = [...block.matchAll(/<category\b([^>]*)\/?>/gi)]
      .map((match) => {
        const term = match[1].match(/\bterm\s*=\s*(["'])([\s\S]*?)\1/i);
        return term ? decodeXmlEntities(term[2]).trim() : "";
      })
      .filter(Boolean);
    const url = feedItemLink(block);
    const stablePart = sourceId || url || cleanXmlText(xmlTag(block, "title"));
    return {
      id: `${sourceRecord.id}:${stablePart}`,
      sourceId,
      title: cleanXmlText(xmlTag(block, "title")),
      url,
      summary: cleanXmlText(xmlTag(block, "description") || xmlTag(block, "summary") || xmlTag(block, "content")),
      publishedAt: normalizedPublishedAt(xmlTag(block, "pubDate") || xmlTag(block, "published") || xmlTag(block, "updated")),
      categories: [...new Set([...rawCategories, ...attributeCategories])],
      source: sourceRecord,
    };
  });
}

function freshnessFromItems(items, checkedAt) {
  const latest = Math.max(...items.map((item) => Date.parse(item.publishedAt)).filter(Number.isFinite));
  if (!Number.isFinite(latest)) return null;
  return Math.max(0, Math.floor((Date.parse(checkedAt) - latest) / 1000));
}

export async function fetchCryptoDailyCandidates({
  now,
  fetchImpl = fetch,
  feeds,
  timeoutMs,
  deadlineMs,
  retryDelayMs,
  delayImpl,
} = {}) {
  const checkedAt = isoNow(now ?? new Date());
  const configuredFeeds = Array.isArray(feeds) ? feeds : DEFAULT_DAILY_FEEDS;
  const deadlineAt = adapterDeadline(timeoutMs, deadlineMs);
  const results = await Promise.all(configuredFeeds.map(async (feed) => {
    const source = normalizedFeedSource(feed);
    try {
      const response = await getWithRetry(source.url, {
        fetchImpl,
        timeoutMs,
        type: "text",
        deadlineAt,
        retryDelayMs,
        delayImpl,
        validate: (xml) => parseRssFeed(xml, source),
      });
      const items = parseRssFeed(response.data, source);
      return {
        items,
        source: sourceHealth({
          id: source.id,
          url: source.url,
          status: "ok",
          checkedAt,
          lastSuccessAt: checkedAt,
          freshnessSeconds: freshnessFromItems(items, checkedAt),
        }),
        warning: null,
      };
    } catch (error) {
      return {
        items: [],
        source: sourceHealth({
          id: source.id,
          url: source.url,
          status: error?.code === "SOURCE_TIMEOUT" ? "timeout" : "error",
          checkedAt,
        }),
        warning: `${source.label} RSS unavailable: ${error.message}`,
      };
    }
  }));
  const windowStart = Date.parse(checkedAt) - 24 * 60 * 60 * 1000;
  const data = results.flatMap((result) => result.items).filter((item) => {
    const publishedAt = Date.parse(item.publishedAt);
    return !Number.isFinite(publishedAt) || (publishedAt >= windowStart && publishedAt <= Date.parse(checkedAt));
  });
  return {
    data,
    candidates: data,
    sources: results.map((result) => result.source),
    warnings: results.map((result) => result.warning).filter(Boolean),
  };
}

function numberValue(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error(`Invalid ${label}`);
  return numeric;
}

function reactionRecord(symbol, beforePrice, price, source, observedAt, beforePriceAt = null) {
  return {
    symbol,
    beforePrice,
    beforePriceAt,
    price,
    changePercent: Number((((price - beforePrice) / beforePrice) * 100).toFixed(4)),
    source,
    observedAt,
  };
}

async function fetchBinanceReaction(symbol, beforeMs, observedAt, requestOptions) {
  const pair = `${symbol}USDT`;
  const lastCompletedMinute = Math.floor(beforeMs / 60_000) * 60_000 - 1;
  const candleUrl = `${BINANCE_API_URL}/api/v3/klines?symbol=${pair}&interval=1m&endTime=${lastCompletedMinute}&limit=100`;
  const tickerUrl = `${BINANCE_API_URL}/api/v3/ticker/price?symbol=${pair}`;
  const candle = await getWithRetry(candleUrl, { ...requestOptions, type: "json" });
  const ticker = await getWithRetry(tickerUrl, { ...requestOptions, type: "json" });
  const selectedCandle = (Array.isArray(candle.data) ? candle.data : [])
    .filter((row) => Array.isArray(row) && Number.isFinite(Number(row[0])) && Number.isFinite(Number(row[6])) && Number(row[6]) <= beforeMs)
    .sort((left, right) => Number(right[6]) - Number(left[6]))[0];
  if (!selectedCandle) throw new Error(`${symbol} Binance completed candle unavailable before target`);
  const candleTime = Number(selectedCandle[0]);
  return reactionRecord(
    symbol,
    numberValue(selectedCandle[4], `${symbol} Binance before price`),
    numberValue(ticker.data?.price, `${symbol} Binance latest price`),
    "Binance",
    observedAt,
    Number.isFinite(candleTime) ? new Date(candleTime).toISOString() : null,
  );
}

async function fetchOkxReaction(symbol, beforeMs, observedAt, requestOptions) {
  const instrument = `${symbol}-USDT`;
  const candleUrl = `${OKX_API_URL}/api/v5/market/candles?instId=${instrument}&bar=1m&after=${beforeMs}&limit=100`;
  const tickerUrl = `${OKX_API_URL}/api/v5/market/ticker?instId=${instrument}`;
  const candle = await getWithRetry(candleUrl, { ...requestOptions, type: "json" });
  const ticker = await getWithRetry(tickerUrl, { ...requestOptions, type: "json" });
  const selectedCandle = (Array.isArray(candle.data?.data) ? candle.data.data : [])
    .filter((row) => {
      const openTime = Number(row?.[0]);
      return Array.isArray(row) && Number.isFinite(openTime) && openTime + 60_000 <= beforeMs && String(row[8]) === "1";
    })
    .sort((left, right) => Number(right[0]) - Number(left[0]))[0];
  if (!selectedCandle) throw new Error(`${symbol} OKX completed candle unavailable before target`);
  return reactionRecord(
    symbol,
    numberValue(selectedCandle[4], `${symbol} OKX before price`),
    numberValue(ticker.data?.data?.[0]?.last, `${symbol} OKX latest price`),
    "OKX",
    observedAt,
    new Date(Number(selectedCandle[0])).toISOString(),
  );
}

async function fetchDxyReaction(beforeMs, nowMs, observedAt, requestOptions) {
  const url = new URL(DXY_API_URL);
  url.searchParams.set("period1", String(Math.floor((beforeMs - 5 * 60 * 1000) / 1000)));
  url.searchParams.set("period2", String(Math.floor((nowMs + 60 * 1000) / 1000)));
  url.searchParams.set("interval", "1m");
  const response = await getWithRetry(url.toString(), { ...requestOptions, type: "json" });
  const result = response.data?.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const points = timestamps.map((timestamp, index) => ({ timestamp: Number(timestamp) * 1000, value: Number(closes[index]) }))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value) && point.value > 0)
    .sort((left, right) => left.timestamp - right.timestamp);
  const beforePoint = points.filter((point) => point.timestamp + 60_000 <= beforeMs).at(-1);
  const latestPoint = points.filter((point) => point.timestamp <= nowMs).at(-1);
  if (!beforePoint || !latestPoint) throw new Error("DXY data unavailable for requested window");
  return reactionRecord(
    "DXY",
    beforePoint.value,
    latestPoint.value,
    "Yahoo Finance",
    observedAt,
    new Date(beforePoint.timestamp).toISOString(),
  );
}

function providerState(id, url, checkedAt, fallbackFrom) {
  return { id, url, checkedAt, fallbackFrom, successes: 0, errors: [], timeout: false };
}

function providerHealth(state) {
  const ok = state.successes > 0 && state.errors.length === 0;
  const status = ok ? "ok" : state.timeout && state.successes === 0 ? "timeout" : state.successes > 0 ? "degraded" : "error";
  return sourceHealth({
    id: state.id,
    url: state.url,
    status,
    checkedAt: state.checkedAt,
    lastSuccessAt: state.successes > 0 ? state.checkedAt : null,
    freshnessSeconds: state.successes > 0 ? 0 : null,
    fallbackFrom: state.fallbackFrom,
  });
}

function noteProviderError(state, error) {
  state.errors.push(error);
  if (error?.code === "SOURCE_TIMEOUT") state.timeout = true;
}

export async function fetchMarketReaction({
  beforeAt,
  now,
  fetchImpl = fetch,
  symbols = ["BTC", "ETH", "DXY"],
  timeoutMs,
  deadlineMs,
  retryDelayMs,
  delayImpl,
} = {}) {
  const observedAt = isoNow(now ?? new Date());
  const nowMs = Date.parse(observedAt);
  const requestedBefore = beforeAt === undefined || beforeAt === null ? nowMs - 60_000 : new Date(beforeAt).getTime();
  const beforeMs = Number.isFinite(requestedBefore) ? requestedBefore : nowMs - 60_000;
  const normalizedSymbols = [...new Set((Array.isArray(symbols) ? symbols : []).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))];
  const requestOptions = {
    fetchImpl,
    timeoutMs,
    deadlineAt: adapterDeadline(timeoutMs, deadlineMs),
    retryDelayMs,
    delayImpl,
  };
  const data = {};
  const warnings = [];
  const providers = {
    binance: providerState("binance", BINANCE_API_URL, observedAt),
    okx: providerState("okx", OKX_API_URL, observedAt, "binance"),
    dxy: providerState("dxy-yahoo-finance", DXY_API_URL, observedAt),
  };

  await Promise.all(normalizedSymbols.map(async (symbol) => {
    if (symbol === "DXY") {
      try {
        data.DXY = await fetchDxyReaction(beforeMs, nowMs, observedAt, requestOptions);
        providers.dxy.successes += 1;
      } catch (error) {
        noteProviderError(providers.dxy, error);
        warnings.push(`DXY optional data unavailable: ${error.message}`);
      }
      return;
    }

    try {
      data[symbol] = await fetchBinanceReaction(symbol, beforeMs, observedAt, requestOptions);
      providers.binance.successes += 1;
      return;
    } catch (error) {
      noteProviderError(providers.binance, error);
    }

    try {
      data[symbol] = await fetchOkxReaction(symbol, beforeMs, observedAt, requestOptions);
      providers.okx.successes += 1;
    } catch (error) {
      noteProviderError(providers.okx, error);
      warnings.push(`${symbol} market reaction unavailable from Binance and OKX: ${error.message}`);
    }
  }));

  const sources = [];
  if (normalizedSymbols.some((symbol) => symbol !== "DXY")) sources.push(providerHealth(providers.binance));
  if (providers.okx.successes || providers.okx.errors.length) sources.push(providerHealth(providers.okx));
  if (normalizedSymbols.includes("DXY")) sources.push(providerHealth(providers.dxy));
  return { data, prices: data, sources, warnings };
}
