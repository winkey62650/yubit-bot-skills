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

function registerManagedSites(db: Database.Database) {
  const insertSite = db.prepare(
    "INSERT OR IGNORE INTO sites (id, name, domain, api_key, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const createdAt = new Date().toISOString();
  insertSite.run("crypto-guy", "Crypto Guy VIP", "https://crypto-guy.vercel.app", "cg_local_7c2f4e91", createdAt);
  insertSite.run("mmcrypto", "MM Crypto", "https://mmcrypto.vercel.app", "mm_local_19a8d3bf", createdAt);
}

export function getDatabase() {
  const scope = globalThis as GlobalDatabase;
  if (scope.agencyAnalyticsDb) return scope.agencyAnalyticsDb;

  fs.mkdirSync(config.dataDirectory, { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  registerManagedSites(db);
  db.prepare("DELETE FROM events WHERE is_demo = 1").run();
  scope.agencyAnalyticsDb = db;
  return db;
}
