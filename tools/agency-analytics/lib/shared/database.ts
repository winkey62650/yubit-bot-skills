import Database from "better-sqlite3";
import fs from "node:fs";
import { config } from "./config";

type GlobalDatabase = typeof globalThis & { agencyAnalyticsDb?: Database.Database };

const schema = `
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '/',
  element_id TEXT,
  value REAL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  user_agent TEXT,
  referrer TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_site_time ON events(site_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_visitor ON events(anonymous_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, occurred_at);
`;

function seededNoise(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function seedDemoData(db: Database.Database) {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number };
  if (existing.count > 0) return;

  const sites = [
    {
      id: "crypto-guy",
      name: "Crypto Guy VIP",
      domain: "https://crypto-guy.vercel.app",
      apiKey: "cg_local_7c2f4e91",
    },
    {
      id: "mmcrypto",
      name: "MM Crypto",
      domain: "https://mmcrypto.vercel.app",
      apiKey: "mm_local_19a8d3bf",
    },
  ];

  const insertSite = db.prepare(
    "INSERT OR IGNORE INTO sites (id, name, domain, api_key, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertEvent = db.prepare(`
    INSERT INTO events
      (site_id, event_type, anonymous_id, session_id, path, element_id, value, duration_ms, occurred_at, user_agent, referrer, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const now = new Date();
  const transaction = db.transaction(() => {
    for (const site of sites) {
      insertSite.run(site.id, site.name, site.domain, site.apiKey, now.toISOString());
    }

    for (let day = 29; day >= 0; day -= 1) {
      for (let siteIndex = 0; siteIndex < sites.length; siteIndex += 1) {
        const site = sites[siteIndex];
        const dayBase = 86 + siteIndex * 31 + Math.round(seededNoise(day + siteIndex * 13) * 72);
        for (let visit = 0; visit < dayBase; visit += 1) {
          const visitor = `demo-v-${siteIndex}-${day}-${Math.floor(visit * 0.73)}`;
          const session = `demo-s-${siteIndex}-${day}-${visit}`;
          const time = new Date(now);
          time.setDate(now.getDate() - day);
          time.setHours(8 + (visit % 13), (visit * 7) % 60, (visit * 11) % 60, 0);
          const iso = time.toISOString();
          const path = visit % 5 === 0 ? "/#academy" : "/";
          insertEvent.run(site.id, "page_view", visitor, session, path, null, null, 0, iso, "Demo", "");

          const duration = 24_000 + Math.round(seededNoise(visit + day * 5 + siteIndex) * 116_000);
          insertEvent.run(site.id, "heartbeat", visitor, session, path, null, null, duration, iso, "Demo", "");

          if ((visit + day + siteIndex) % 7 < 2) {
            insertEvent.run(site.id, "cta_click", visitor, session, path, visit % 2 ? "join-free-hero" : "join-free-footer", null, 0, iso, "Demo", "");
          }
          if ((visit * 3 + day + siteIndex) % 10 < 4) {
            insertEvent.run(site.id, "video_play", visitor, session, path, "hero-video", null, 0, iso, "Demo", "");
          }
        }
      }
    }
  });

  transaction();
}

export function getDatabase() {
  const scope = globalThis as GlobalDatabase;
  if (scope.agencyAnalyticsDb) return scope.agencyAnalyticsDb;

  fs.mkdirSync(config.dataDirectory, { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  seedDemoData(db);
  scope.agencyAnalyticsDb = db;
  return db;
}
