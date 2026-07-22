import { getDatabase } from "@/lib/shared/database";
import type { Site } from "@/lib/shared/types";

type SiteRow = {
  id: string;
  name: string;
  domain: string;
  api_key: string;
  created_at: string;
  last_event_at: string | null;
  is_demo: number;
};

function mapSite(row: SiteRow): Site {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    apiKey: row.api_key,
    createdAt: row.created_at,
    lastEventAt: row.last_event_at,
    isDemo: Boolean(row.is_demo),
  };
}

export const siteRepository = {
  list() {
    const rows = getDatabase()
      .prepare(`
        SELECT s.id, s.name, s.domain, s.api_key, s.created_at,
               MAX(e.occurred_at) AS last_event_at,
               CASE WHEN COUNT(e.id) > 0 AND SUM(CASE WHEN e.is_demo = 0 THEN 1 ELSE 0 END) = 0 THEN 1 ELSE 0 END AS is_demo
        FROM sites s
        LEFT JOIN events e ON e.site_id = s.id
        WHERE s.archived_at IS NULL
        GROUP BY s.id
        ORDER BY s.created_at DESC
      `)
      .all() as SiteRow[];
    return rows.map(mapSite);
  },

  findById(id: string) {
    return getDatabase()
      .prepare("SELECT id, name, domain, api_key, created_at, NULL AS last_event_at, 0 AS is_demo FROM sites WHERE id = ? AND archived_at IS NULL")
      .get(id) as SiteRow | undefined;
  },

  create(site: { id: string; name: string; domain: string; apiKey: string; createdAt: string }) {
    getDatabase()
      .prepare("INSERT INTO sites (id, name, domain, api_key, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(site.id, site.name, site.domain, site.apiKey, site.createdAt);
    return mapSite({ ...site, api_key: site.apiKey, created_at: site.createdAt, last_event_at: null, is_demo: 0 });
  },

  archive(id: string, archivedAt: string) {
    return getDatabase()
      .prepare("UPDATE sites SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(archivedAt, id);
  },
};
