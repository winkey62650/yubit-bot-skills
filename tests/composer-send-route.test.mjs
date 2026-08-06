import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("manual composer reports failure when Telegram delivers to no targets", async () => {
  const source = await readFile(
    new URL("../app/api/composer/send/route.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /errors\.length\s*>\s*0/);
  assert.match(source, /results\.length\s*===\s*0/);
  assert.match(source, /ok:\s*false/);
  assert.doesNotMatch(
    source,
    /return NextResponse\.json\(\{ ok: true, results, errors \}\)/
  );
});

test("manual composer excludes unresolved forum topics from selectable targets", async () => {
  const source = await readFile(
    new URL("../app/composer/page.jsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /topic\.threadId\s*!==\s*null/);
  assert.match(source, /topic\.threadId\s*!==\s*undefined/);
});
