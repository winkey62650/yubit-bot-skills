import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { neon } from "@neondatabase/serverless";

export function classifyDatabaseFailure(error) {
  const message = String(error?.message || error);
  if (/HTTP status 402|compute time quota/i.test(message)) {
    return "compute quota exceeded";
  }
  if (/fetch failed|network|connect|timeout|ECONN|ENOTFOUND/i.test(message)) {
    return "connection failed";
  }
  return "query failed";
}

export async function checkProductionDatabase({ env, query = queryDatabase }) {
  const url = env.DATABASE_URL || env.POSTGRES_URL;
  if (!url) {
    throw new Error("DATABASE_URL or POSTGRES_URL must be configured");
  }
  await query(url);
}

async function queryDatabase(url) {
  await neon(url)`SELECT 1 AS ok`;
}

export function parseEnvFile(source) {
  return Object.fromEntries(
    source.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf("=");
      if (separator < 1 || line.trim().startsWith("#")) return [];
      const key = line.slice(0, separator).trim();
      const value = line
        .slice(separator + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      return [[key, value]];
    }),
  );
}

async function main() {
  const envFile = process.env.ENV_FILE;
  if (!envFile) throw new Error("ENV_FILE must be configured");
  const env = parseEnvFile(await readFile(envFile, "utf8"));
  try {
    await checkProductionDatabase({ env });
    console.log("Production database preflight: ok");
  } catch (error) {
    console.error(`Production database preflight failed: ${classifyDatabaseFailure(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
