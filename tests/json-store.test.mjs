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

test("a dedicated server release ignores stale Vercel Blob credentials by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yubit-server-json-store-"));
  const original = {
    backend: process.env.JSON_STORE_BACKEND,
    directory: process.env.JSON_STORE_DIRECTORY,
    releaseSha: process.env.APP_RELEASE_SHA,
    vercel: process.env.VERCEL,
    blobToken: process.env.BLOB_READ_WRITE_TOKEN
  };

  process.env.JSON_STORE_BACKEND = "blob";
  delete process.env.VERCEL;
  process.env.JSON_STORE_DIRECTORY = directory;
  process.env.APP_RELEASE_SHA = "server-release-sha";
  process.env.BLOB_READ_WRITE_TOKEN = "expired-production-token";

  try {
    const expected = { schemaVersion: 2, groups: [{ chatId: "-1002" }] };
    await store.writeJson("group-config.json", expected);
    assert.deepEqual(await store.readJson("group-config.json", {}), expected);
  } finally {
    restoreEnvironment("JSON_STORE_BACKEND", original.backend);
    restoreEnvironment("JSON_STORE_DIRECTORY", original.directory);
    restoreEnvironment("APP_RELEASE_SHA", original.releaseSha);
    restoreEnvironment("VERCEL", original.vercel);
    restoreEnvironment("BLOB_READ_WRITE_TOKEN", original.blobToken);
    await rm(directory, { recursive: true, force: true });
  }
});

test("serialized JSON updates do not lose concurrent changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yubit-json-update-"));
  const original = {
    backend: process.env.JSON_STORE_BACKEND,
    directory: process.env.JSON_STORE_DIRECTORY,
  };

  process.env.JSON_STORE_BACKEND = "local";
  process.env.JSON_STORE_DIRECTORY = directory;

  try {
    await store.writeJson("rules.json", { rules: [] });
    await Promise.all([
      store.updateJson("rules.json", (current) => ({ rules: [...current.rules, "a"] }), { rules: [] }),
      store.updateJson("rules.json", (current) => ({ rules: [...current.rules, "b"] }), { rules: [] }),
    ]);
    assert.deepEqual((await store.readJson("rules.json", {})).rules, ["a", "b"]);
  } finally {
    restoreEnvironment("JSON_STORE_BACKEND", original.backend);
    restoreEnvironment("JSON_STORE_DIRECTORY", original.directory);
    await rm(directory, { recursive: true, force: true });
  }
});

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
