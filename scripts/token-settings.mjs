import { readFile } from "node:fs/promises";
import process from "node:process";

const tokenFile = process.env.TOKEN_FILE || ".env.telegram-tokens.local";
const role = process.env.BOT_ROLE || "admin";
const roleMap = {
  admin: "YUBITADMIN_BOT_TOKEN",
  trader: "TRADER1_BOT_TOKEN",
  forward: "FORWARD_BOT_TOKEN",
  mod: "MOD1_BOT_TOKEN",
  jack: "JACK_BOT_TOKEN",
  tony: "TONY_BOT_TOKEN"
};

let fileTokens = {};

try {
  fileTokens = parseEnv(await readFile(tokenFile, "utf8"));
} catch {
  fileTokens = {};
}

const key = roleMap[role] || roleMap.admin;
const token = process.env[key] || fileTokens[key] || process.env.TELEGRAM_BOT_TOKEN || "";

console.log(
  JSON.stringify(
    {
      action: "token-settings",
      tokenFile,
      role,
      envKey: key,
      configured: Boolean(token),
      maskedToken: token ? mask(token) : null,
      availableRoles: Object.fromEntries(Object.entries(roleMap).map(([name, envKey]) => [name, Boolean(process.env[envKey] || fileTokens[envKey])]))
    },
    null,
    2
  )
);

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

function mask(value) {
  if (value.length < 12) return "***";
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}
