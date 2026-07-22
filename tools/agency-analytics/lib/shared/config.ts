import path from "node:path";

function positiveInt(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const dataDirectory = process.env.AGENCY_ANALYTICS_DATA_DIR
  ? path.resolve(process.env.AGENCY_ANALYTICS_DATA_DIR)
  : path.join(process.cwd(), "data");

export const config = {
  dataDirectory,
  databasePath: path.join(dataDirectory, "agency-analytics.db"),
  refreshMs: positiveInt("NEXT_PUBLIC_DASHBOARD_REFRESH_MS", 30_000),
  collectorUrl: process.env.NEXT_PUBLIC_COLLECTOR_URL || "http://127.0.0.1:3100",
} as const;
