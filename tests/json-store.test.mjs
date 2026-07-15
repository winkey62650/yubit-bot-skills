import assert from "node:assert/strict";
import test from "node:test";
import * as store from "../lib/json-store.js";

test("Vercel Blob JSON reads bypass the CDN cache", async () => {
  assert.equal(typeof store.readBlobJson, "function");

  let receivedOptions;
  const value = await store.readBlobJson("group-config.json", {}, async (_pathname, options) => {
    receivedOptions = options;
    return { stream: new Response('{"schemaVersion":2}').body };
  });

  assert.equal(receivedOptions.access, "private");
  assert.equal(receivedOptions.useCache, false);
  assert.deepEqual(value, { schemaVersion: 2 });
});
