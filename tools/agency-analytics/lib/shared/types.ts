export const EVENT_TYPES = [
  "page_view",
  "cta_click",
  "video_play",
  "heartbeat",
  "session_end",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type Site = {
  id: string;
  name: string;
  domain: string;
  apiKey: string;
  createdAt: string;
  lastEventAt: string | null;
  isDemo: boolean;
};

export type AnalyticsKpis = {
  pv: number;
  uv: number;
  sessions: number;
  ctaClicks: number;
  ctaRate: number;
  videoPlays: number;
  videoPlayRate: number;
  avgDwellSeconds: number;
};

export type TrendPoint = {
  date: string;
  pv: number;
  uv: number;
  ctaClicks: number;
  videoPlays: number;
};

export type SitePerformance = AnalyticsKpis & {
  id: string;
  name: string;
  domain: string;
  lastEventAt: string | null;
  isDemo: boolean;
};

export type RecentEvent = {
  id: number;
  siteName: string;
  eventType: EventType;
  path: string;
  elementId: string | null;
  occurredAt: string;
};

export type AnalyticsResponse = {
  generatedAt: string;
  rangeDays: number;
  dataMode: "empty" | "live";
  kpis: AnalyticsKpis;
  trend: TrendPoint[];
  sites: SitePerformance[];
  topCtas: Array<{ elementId: string; clicks: number }>;
  recentEvents: RecentEvent[];
};
