import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  HOME_BY_ROLE,
  canQueueComposerMessage,
  canAccessPath,
  filterNavigationForRole
} from "../lib/access-control.mjs";

test("manual publisher only sees manual publishing and readonly publisher status", () => {
  assert.equal(HOME_BY_ROLE.manual_publisher, "/composer");
  assert.equal(canAccessPath("manual_publisher", "/composer", "GET"), true);
  assert.equal(canAccessPath("manual_publisher", "/telegram-user-authorization", "GET"), true);
  assert.equal(canAccessPath("manual_publisher", "/api/composer/send", "POST"), true);
  assert.equal(canAccessPath("manual_publisher", "/api/telegram/dialogs", "GET"), true);
  assert.equal(canAccessPath("manual_publisher", "/api/telegram/user-authorization", "GET"), true);
  assert.equal(canAccessPath("manual_publisher", "/api/telegram/user-authorization", "POST"), false);
  assert.equal(canAccessPath("manual_publisher", "/discord/manual", "GET"), true);
  assert.equal(canAccessPath("manual_publisher", "/api/discord/manual", "GET"), true);
  assert.equal(canAccessPath("manual_publisher", "/api/discord/manual", "POST"), true);
  assert.equal(canAccessPath("manual_publisher", "/api/discord", "GET"), false);
  assert.equal(canAccessPath("manual_publisher", "/api/discord", "POST"), false);
  assert.equal(canAccessPath("manual_publisher", "/api/telegram-auth/session", "DELETE"), false);
  assert.equal(canAccessPath("manual_publisher", "/distribution", "GET"), false);
  assert.equal(canAccessPath("manual_publisher", "/api/distribution", "GET"), false);
  assert.equal(canQueueComposerMessage("manual_publisher"), false);
});

test("admin retains full access and restricted navigation is filtered", () => {
  assert.equal(canAccessPath("admin", "/distribution", "GET"), true);
  assert.equal(canAccessPath("admin", "/api/distribution", "POST"), true);
  assert.equal(canQueueComposerMessage("admin"), true);
  const items = [
    { href: "/distribution", roles: ["admin"] },
    { href: "/composer", roles: ["admin", "manual_publisher"] },
    { href: "/telegram-user-authorization", roles: ["admin", "manual_publisher"] }
  ];
  assert.deepEqual(
    filterNavigationForRole(items, "manual_publisher").map((item) => item.href),
    ["/composer", "/telegram-user-authorization"]
  );
});

test("nested platform navigation keeps only sections with visible destinations", () => {
  const sections = [
    {
      key: "telegram",
      roles: ["admin", "manual_publisher"],
      items: [
        { href: "/distribution", roles: ["admin"] },
        { href: "/composer", roles: ["admin", "manual_publisher"] }
      ]
    },
    {
      key: "discord",
      roles: ["admin", "manual_publisher"],
      items: [
        { href: "/discord", roles: ["admin"] },
        { href: "/discord/manual", roles: ["admin", "manual_publisher"] }
      ]
    }
  ];

  assert.deepEqual(filterNavigationForRole(sections, "manual_publisher"), [
    {
      key: "telegram",
      roles: ["admin", "manual_publisher"],
      items: [{ href: "/composer", roles: ["admin", "manual_publisher"] }]
    },
    {
      key: "discord",
      roles: ["admin", "manual_publisher"],
      items: [{ href: "/discord/manual", roles: ["admin", "manual_publisher"] }]
    }
  ]);
});

test("restricted page redirects use the public application origin behind a proxy", async () => {
  const middleware = await readFile(new URL("../middleware.js", import.meta.url), "utf8");
  assert.match(
    middleware,
    /process\.env\.APP_BASE_URL \? new URL\(process\.env\.APP_BASE_URL\) : request\.nextUrl\.clone\(\)/
  );
});
