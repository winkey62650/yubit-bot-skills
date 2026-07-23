import { z } from "zod";
import type { AnalyticsKpis, AnalyticsResponse, SitePerformance, TrendPoint } from "@/lib/shared/types";
import { analyticsRepository, type AggregateRow } from "./analytics.repository";

const querySchema = z.object({
  range: z.enum(["7d", "30d", "90d"]).default("30d"),
  site: z.string().max(80).default("all"),
});

function round(value: number, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toKpis(row: AggregateRow): AnalyticsKpis {
  const sessions = Number(row.sessions || 0);
  return {
    pv: Number(row.pv || 0),
    uv: Number(row.uv || 0),
    sessions,
    ctaClicks: Number(row.cta_clicks || 0),
    ctaRate: sessions ? round((Number(row.cta_sessions || 0) / sessions) * 100) : 0,
    videoPlays: Number(row.video_plays || 0),
    videoPlayRate: sessions ? round((Number(row.video_sessions || 0) / sessions) * 100) : 0,
    avgDwellSeconds: sessions ? Math.round(Number(row.dwell_ms || 0) / sessions / 1000) : 0,
  };
}

function fillTrend(rows: ReturnType<typeof analyticsRepository.trend>, days: number) {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const result: TrendPoint[] = [];
  const today = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const row = byDate.get(key);
    result.push({
      date: key,
      pv: Number(row?.pv || 0),
      uv: Number(row?.uv || 0),
      ctaClicks: Number(row?.cta_clicks || 0),
      videoPlays: Number(row?.video_plays || 0),
    });
  }
  return result;
}

export const analyticsService = {
  dashboard(input: { range?: string | null; site?: string | null }): AnalyticsResponse {
    const parsed = querySchema.parse({ range: input.range || undefined, site: input.site || undefined });
    const days = Number(parsed.range.replace("d", ""));
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    start.setHours(0, 0, 0, 0);

    const aggregate = analyticsRepository.aggregate(start.toISOString(), parsed.site);
    const siteRows = analyticsRepository.sites(start.toISOString(), parsed.site);
    const sites: SitePerformance[] = siteRows.map((row) => ({
      id: row.id,
      name: row.name,
      domain: row.domain,
      lastEventAt: row.last_event_at,
      isDemo: Boolean(row.is_demo),
      ...toKpis(row),
    }));

    return {
      generatedAt: new Date().toISOString(),
      rangeDays: days,
      dataMode: Number(aggregate.real_events || 0) > 0 ? "live" : "empty",
      kpis: toKpis(aggregate),
      trend: fillTrend(analyticsRepository.trend(start.toISOString(), parsed.site), days),
      sites,
      topCtas: analyticsRepository.topCtas(start.toISOString(), parsed.site).map((row) => ({
        elementId: row.element_id,
        clicks: Number(row.clicks),
      })),
      recentEvents: analyticsRepository.recentEvents(parsed.site),
    };
  },
};
