import { neon } from "@neondatabase/serverless";
import pg from "pg";

const { Pool } = pg;

export function selectPostgresDriver(databaseUrl, env = process.env) {
  const configured = String(env.DATABASE_DRIVER || "").trim().toLowerCase();
  if (configured === "pg" || configured === "neon") return configured;
  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return "pg";
  } catch {}
  return "neon";
}

export function createPostgresClient(databaseUrl, options = {}) {
  const env = options.env ?? process.env;
  if (selectPostgresDriver(databaseUrl, env) === "neon") {
    const sql = (options.neonFactory ?? neon)(databaseUrl);
    return { query: (statement, params) => sql.query(statement, params) };
  }

  const pool = options.createPool
    ? options.createPool({ connectionString: databaseUrl })
    : new Pool({ connectionString: databaseUrl, max: Number(env.DATABASE_POOL_MAX || 10) });
  return {
    async query(statement, params) {
      const result = await pool.query(statement, params);
      return result.rows;
    },
    async close() {
      await pool.end?.();
    },
  };
}
