function clean(value, fallback = "") {
  return String(value ?? fallback).replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

function metric(nodes, label) {
  return (Array.isArray(nodes) ? nodes : []).find((node) => node?.type === "metric" && node?.label === label)?.value ?? null;
}

function dayLabel(date, index) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return `DAY ${index + 1}`;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", day: "2-digit" })
    .format(parsed)
    .toUpperCase();
}

export function buildWeeklyCalendarPosterModel(document = {}) {
  const sourceDays = Array.isArray(document.days) ? document.days.slice(0, 5) : [];
  const flattened = sourceDays.flatMap((day, dayIndex) => (Array.isArray(day.events) ? day.events : []).map((event) => ({
    dayIndex,
    id: clean(event.id, `${dayIndex}`),
    title: clean(event.title, "Verified event").slice(0, 48),
    time: clean(event.time, "TBD"),
    importance: Number(event.importance ?? (metric(event.nodes, "Importance")?.includes("High") ? 3 : 0)),
  })));
  const selectedIds = new Set(flattened
    .sort((left, right) => right.importance - left.importance || left.dayIndex - right.dayIndex || left.time.localeCompare(right.time))
    .slice(0, 8)
    .map((event) => `${event.dayIndex}:${event.id}`));
  const columns = Array.from({ length: 5 }, (_, dayIndex) => {
    const day = sourceDays[dayIndex] ?? {};
    return {
      date: clean(day.date),
      label: dayLabel(day.date, dayIndex),
      events: flattened
        .filter((event) => event.dayIndex === dayIndex && selectedIds.has(`${event.dayIndex}:${event.id}`))
        .sort((left, right) => left.time.localeCompare(right.time))
        .map((event) => ({ ...event, accent: event.importance >= 3 ? "amber" : "carbon" })),
    };
  });
  return {
    kind: "weekly-calendar",
    title: clean(document.title, "WEEKLY MARKET CALENDAR"),
    weekStart: clean(document.weekStart),
    columns,
  };
}

export function buildDataUpdatePosterModel(input = {}) {
  const values = input.values ?? input.event?.values ?? {};
  const forecast = clean(values.forecast) || null;
  const forecastSource = clean(input.forecastSource ?? input.event?.forecastSource);
  return {
    kind: "data-update",
    title: clean(input.title ?? input.event?.title, "DATA UPDATE"),
    indicator: clean(input.indicator ?? input.event?.indicator).toUpperCase(),
    impact: clean(input.impact, "Neutral"),
    actual: clean(values.actual, "—"),
    previous: clean(values.previous) || null,
    revised: clean(values.revised) || null,
    forecast,
    forecastLabel: forecast ? `AUXILIARY FORECAST${forecastSource ? ` · ${forecastSource.toUpperCase()}` : ""}` : null,
    source: clean(input.source?.label ?? input.event?.source?.label, "OFFICIAL RELEASE").toUpperCase(),
  };
}

export function buildCryptoDailyPosterModel(document = {}) {
  const selected = Array.isArray(document.selectedStories)
    ? document.selectedStories
    : (Array.isArray(document.sections) ? document.sections.map((section) => section.story).filter(Boolean) : []);
  return {
    kind: "crypto-daily",
    date: clean(document.generatedAt).slice(0, 10),
    title: "MARKET SIGNALS",
    stories: selected.slice(0, 3).map((story, index) => ({
      rank: String(index + 1).padStart(2, "0"),
      title: clean(story.title, "Verified market development").slice(0, 64),
      score: Math.round(Number(story?.marketImpact?.score ?? story?.impactScore) || 0),
    })),
  };
}
