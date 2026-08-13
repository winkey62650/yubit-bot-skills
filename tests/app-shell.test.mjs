import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("app shell declares an existing favicon instead of triggering /favicon.ico 404s", async () => {
  const root = new URL("../", import.meta.url);
  const layout = await readFile(new URL("app/layout.jsx", root), "utf8");

  assert.match(layout, /icon:\s*["']\/favicon\.svg["']/);
  await access(new URL("public/favicon.svg", root));
});

test("console navigation groups Telegram and Discord business areas", async () => {
  const root = new URL("../", import.meta.url);
  const shell = await readFile(new URL("app/components/ConsoleShell.jsx", root), "utf8");

  assert.match(shell, /const navSections = \[/);
  assert.match(shell, /key: "telegram"[\s\S]*label: "nav\.telegram"[\s\S]*href: "\/group-config"/);
  assert.match(shell, /key: "discord"[\s\S]*label: "nav\.discord"[\s\S]*href: "\/discord"/);
  assert.ok(shell.indexOf('key: "telegram"') < shell.indexOf('key: "discord"'));
});

test("Telegram and Discord navigation lists can independently expand and collapse", async () => {
  const root = new URL("../", import.meta.url);
  const shell = await readFile(new URL("app/components/ConsoleShell.jsx", root), "utf8");

  assert.match(shell, /key: "telegram"[\s\S]*?collapsible: true/);
  assert.match(shell, /key: "discord"[\s\S]*?collapsible: true/);
  assert.match(shell, /useState\(\{ telegram: true, discord: true \}\)/);
  assert.match(shell, /aria-expanded=\{expanded\}/);
  assert.match(shell, /aria-controls=\{panelId\}/);
  assert.match(shell, /hidden=\{section\.collapsible && !expanded\}/);
  assert.match(shell, /toggleNavigationSection\(section\.key\)/);
  assert.match(shell, /yubit-console-navigation-sections/);
});
