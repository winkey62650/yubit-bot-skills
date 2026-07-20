import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("the server-local backend overrides stale Vercel Blob credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yubit-json-store-"));
  const original = {
    backend: process.env.JSON_STORE_BACKEND,
    directory: process.env.JSON_STORE_DIRECTORY,
    blobToken: process.env.BLOB_READ_WRITE_TOKEN
  };

  process.env.JSON_STORE_BACKEND = "local";
  process.env.JSON_STORE_DIRECTORY = directory;
  process.env.BLOB_READ_WRITE_TOKEN = "expired-production-token";

  try {
    const expected = { schemaVersion: 2, groups: [{ chatId: "-1001" }] };
    await store.writeJson("group-config.json", expected);
    assert.deepEqual(await store.readJson("group-config.json", {}), expected);
  } finally {
    restoreEnvironment("JSON_STORE_BACKEND", original.backend);
    restoreEnvironment("JSON_STORE_DIRECTORY", original.directory);
    restoreEnvironment("BLOB_READ_WRITE_TOKEN", original.blobToken);
    await rm(directory, { recursive: true, force: true });
  }
});

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
