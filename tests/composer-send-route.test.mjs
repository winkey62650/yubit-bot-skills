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

test("manual composer isolates targets when the sending account changes", async () => {
  const source = await readFile(
    new URL("../app/composer/page.jsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /setSelectedTargets\(\[\]\)/);
  assert.match(source, /buildAccountTargetGroups/);
  assert.doesNotMatch(source, /const newGroups = \[\.\.\.currentGroups\]/);
});

test("manual composer validates targets against the selected account before queueing or sending", async () => {
  const source = await readFile(
    new URL("../app/api/composer/send/route.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /assertAccountCanSendToTargets/);
  assert.match(source, /telegramMtprotoCall\(null, "getDialogs"/);
  assert.match(source, /hydrateTelegramTopicAvailability/);
  assert.match(source, /topicIdsByChatFromTargets/);
  assert.match(source, /expandAutomaticBroadcastTargets/);
  assert.match(source, /requestedTargets\.map\(composerTargetEndpoint\)/);
});

test("manual composer disables unverified topics and refreshes their live state", async () => {
  const source = await readFile(
    new URL("../app/composer/page.jsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /canSendMessages\s*===\s*true/);
  assert.match(source, /disabled=\{sending \|\| targetsLoading \|\| !opt\.available\}/);
  assert.match(source, /setInterval/);
});

test("manual composer collapses destinations by group and only selects live writable topics", async () => {
  const source = await readFile(
    new URL("../app/composer/page.jsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /<details key=\{group\.chatId\}/);
  assert.match(source, /<summary/);
  assert.match(source, /group\.options\.map\(\(opt\)/);
  assert.match(source, /group\.options\.filter\(\(option\) => option\.available\)/);
  assert.doesNotMatch(source, /id="selectAll"/);
});

test("manual composer can search Telegram groups and Topics", async () => {
  const source = await readFile(
    new URL("../app/composer/page.jsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /filterTelegramComposerTargets/);
  assert.match(source, /type="search"/);
  assert.match(source, /composer\.targetSearchPlaceholder/);
  assert.match(source, /open=\{targetSearch\.trim\(\) \? true : undefined\}/);
});

test("manual composer accepts an optional CTA text and link", async () => {
  const [page, route] = await Promise.all([
    readFile(new URL("../app/composer/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/composer/send/route.js", import.meta.url), "utf8"),
  ]);

  assert.match(page, /ctaText/);
  assert.match(page, /ctaUrl/);
  assert.match(page, /composer\.ctaText/);
  assert.match(page, /composer\.ctaUrl/);
  assert.match(page, /formData\.append\("ctaText"/);
  assert.match(page, /formData\.append\("ctaUrl"/);
  assert.match(route, /composeManualMessage/);
  assert.match(route, /formData\.get\("ctaText"\)/);
  assert.match(route, /formData\.get\("ctaUrl"\)/);
});

test("queued composer rechecks exact topic availability immediately before delivery", async () => {
  const source = await readFile(
    new URL("../app/api/cron/composer/route.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /hydrateTelegramTopicAvailability/);
  assert.match(source, /assertAccountCanSendToTargets/);
});
