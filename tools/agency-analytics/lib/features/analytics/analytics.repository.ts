import { getDatabase } from "@/lib/shared/database";
import type { EventType, RecentEvent, SitePerformance, TrendPoint } from "@/lib/shared/types";

type AggregateRow = {
  pv: number;
  uv: number;
  sessions: number;
  cta_clicks: number;
  cta_sessions: number;
  video_plays: number;
  video_sessions: number;
  dwell_ms: number;
  real_events: number;
  demo_events: number;
};

const aggregateSql = `
  COUNT(CASE WHEN event_type = 'page_view' THEN 1 END) AS pv,
  COUNT(DISTINCT CASE WHEN event_type = 'page_view' THEN anonymous_id END) AS uv,
  COUNT(DISTINCT CASE WHEN event_type = 'page_view' THEN session_id END) AS sessions,
  COUNT(CASE WHEN event_type = 'cta_click' THEN 1 END) AS cta_clicks,
  COUNT(DISTINCT CASE WHEN event_type = 'cta_click' THEN session_id END) AS cta_sessions,
  COUNT(CASE WHEN event_type = 'video_play' THEN 1 END) AS video_plays,
  COUNT(DISTINCT CASE WHEN event_type = 'video_play' THEN session_id END) AS video_sessions,
  COALESCE(SUM(CASE WHEN event_type IN ('heartbeat', 'session_end') THEN duration_ms ELSE 0 END), 0) AS dwell_ms,
  COUNT(CASE WHEN is_demo = 0 THEN 1 END) AS real_events,
  COUNT(CASE WHEN is_demo = 1 THEN 1 END) AS demo_events
`;

function params(start: string, siteId: string) {
  return { start, siteId };
}

export const analyticsRepository = {
  aggregate(start: string, siteId: string) {
    return getDatabase()
      .prepare(`SELECT ${aggregateSql} FROM events WHERE occurred_at >= @start AND (@siteId = 'all' OR site_id = @siteId)`)
      .get(params(start, siteId)) as AggregateRow;
  },

  trend(start: string, siteId: string) {
    return getDatabase()
      .prepare(`
        SELECT date(occurred_at, 'localtime') AS date,
          COUNT(CASE WHEN event_type = 'page_view' THEN 1 END) AS pv,
          COUNT(DISTINCT CASE WHEN event_type = 'page_view' THEN anonymous_id END) AS uv,
          COUNT(CASE WHEN event_type = 'cta_click' THEN 1 END) AS cta_clicks,
          COUNT(CASE WHEN event_type = 'video_play' THEN 1 END) AS video_plays
        FROM events
        WHERE occurred_at >= @start AND (@siteId = 'all' OR site_id = @siteId)
        GROUP BY date(occurred_at, 'localtime')
        ORDER BY date ASC
      `)
      .all(params(start, siteId)) as Array<{
        date: string;
        pv: number;
        uv: number;
        cta_clicks: number;
        video_plays: number;
      }>;
  },

  sites(start: string, siteId: string) {
    const rows = getDatabase()
      .prepare(`
        SELECT s.id, s.name, s.domain, MAX(e.occurred_at) AS last_event_at,
          CASE WHEN COUNT(e.id) > 0 AND SUM(CASE WHEN e.is_demo = 0 THEN 1 ELSE 0 END) = 0 THEN 1 ELSE 0 END AS is_demo,
          ${aggregateSql}
        FROM sites s
        LEFT JOIN events e ON e.site_id = s.id AND e.occurred_at >= @start
        WHERE s.archived_at IS NULL AND (@siteId = 'all' OR s.id = @siteId)
        GROUP BY s.id
        ORDER BY pv DESC
      `)
      .all(params(start, siteId)) as Array<AggregateRow & {
        id: string;
        name: string;
        domain: string;
        last_event_at: string | null;
        is_demo: number;
      }>;
    return rows;
  },

  topCtas(start: string, siteId: string) {
    return getDatabase()
      .prepare(`
        SELECT COALESCE(element_id, 'unnamed-cta') AS element_id, COUNT(*) AS clicks
        FROM events
        WHERE occurred_at >= @start AND event_type = 'cta_click' AND (@siteId = 'all' OR site_id = @siteId)
        GROUP BY element_id
        ORDER BY clicks DESC
        LIMIT 6
      `)
      .all(params(start, siteId)) as Array<{ element_id: string; clicks: number }>;
  },

  recentEvents(siteId: string) {
    const rows = getDatabase()
      .prepare(`
        SELECT e.id, s.name AS site_name, e.event_type, e.path, e.element_id, e.occurred_at
        FROM events e
        JOIN sites s ON s.id = e.site_id
        WHERE (@siteId = 'all' OR e.site_id = @siteId)
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT 12
      `)
      .all({ siteId }) as Array<{
        id: number;
        site_name: string;
        event_type: EventType;
        path: string;
        element_id: string | null;
        occurred_at: string;
      }>;
    return rows.map<RecentEvent>((row) => ({
      id: row.id,
      siteName: row.site_name,
      eventType: row.event_type,
      path: row.path,
      elementId: row.element_id,
      occurredAt: row.occurred_at,
    }));
  },
};

export type { AggregateRow };
