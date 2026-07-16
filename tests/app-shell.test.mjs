import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("app shell declares an existing favicon instead of triggering /favicon.ico 404s", async () => {
  const root = new URL("../", import.meta.url);
  const layout = await readFile(new URL("app/layout.jsx", root), "utf8");

  assert.match(layout, /icon:\s*["']\/favicon\.svg["']/);
  await access(new URL("public/favicon.svg", root));
});
