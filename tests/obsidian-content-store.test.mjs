import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createObsidianContentStore } from "../lib/obsidian-content-store.mjs";

const REQUIRED_DIRECTORIES = [
  "00 System",
  "10 Sources",
  "20 Events",
  "30 Products",
  "30 Products/Daily Market Brief",
  "30 Products/Weekly Catalyst Calendar",
  "30 Products/Data Flash",
  "30 Products/Market Follow-up",
  "40 Distribution",
  "50 Feedback",
  "90 Archive",
  "_assets",
];

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "yubit-obsidian-store-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createStore(vaultPath, iso = "2026-08-23T08:09:10.000Z") {
  return createObsidianContentStore({
    vaultPath,
    now: () => new Date(iso),
  });
}

function product(overrides = {}) {
  return {
    id: "daily-market-brief-2026-08-23",
    product: "daily-market-brief",
    status: "draft",
    eventId: "market-day-2026-08-23",
    title: "Daily Market Brief — 2026-08-23",
    language: "en",
    sourceRefs: ["source-fed-2026-08-23"],
    body: "BTC held above the observed range.",
    ...overrides,
  };
}

test("initialize creates the exact governed vault folders and indexes idempotently", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const store = createStore(vaultPath);

    const first = await store.initialize();
    const second = await store.initialize();

    assert.equal(first.ready, true);
    assert.equal(second.ready, true);
    for (const relativePath of REQUIRED_DIRECTORIES) {
      const entries = await readdir(join(vaultPath, relativePath));
      assert.ok(entries.includes("INDEX.md"), `${relativePath} must contain INDEX.md`);
      const index = await readFile(join(vaultPath, relativePath, "INDEX.md"), "utf8");
      assert.match(index, /^---\n/);
      assert.match(index, /schema: "yubit-obsidian-index\/v1"/);
    }

    const health = await store.health();
    assert.deepEqual(health, {
      ready: true,
      vaultPath,
      checkedDirectories: REQUIRED_DIRECTORIES.length,
      productDirectories: REQUIRED_DIRECTORIES.slice(4, 8),
      writable: true,
    });
  });
});

test("initializer CLI uses OBSIDIAN_VAULT_PATH and is idempotent", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const scriptPath = fileURLToPath(new URL("../scripts/initialize-content-vault.mjs", import.meta.url));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync(process.execPath, [scriptPath], {
        encoding: "utf8",
        env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultPath },
      });
      assert.equal(result.status, 0, result.stderr);
      const response = JSON.parse(result.stdout);
      assert.equal(response.ready, true);
      assert.equal(response.vaultPath, vaultPath);
    }
  });
});

test("product notes use canonical queryable frontmatter and survive a store restart", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const firstStore = createStore(vaultPath);
    await firstStore.initialize();

    const written = await firstStore.writeProduct(product());
    assert.equal(written.relativePath, "30 Products/Daily Market Brief/daily-market-brief-2026-08-23.md");
    const markdown = await readFile(join(vaultPath, written.relativePath), "utf8");
    assert.match(markdown, /schema: "yubit-obsidian-note\/v1"/);
    assert.match(markdown, /kind: "product"/);
    assert.match(markdown, /id: "daily-market-brief-2026-08-23"/);
    assert.match(markdown, /product: "daily-market-brief"/);
    assert.match(markdown, /status: "draft"/);
    assert.match(markdown, /event_id: "market-day-2026-08-23"/);
    assert.match(markdown, /content_hash: "sha256:[a-f0-9]{64}"/);
    assert.match(markdown, /```json\n\{[^]*\}\n```\n$/);

    const restartedStore = createStore(vaultPath, "2026-08-23T09:10:11.000Z");
    assert.deepEqual(
      await restartedStore.readProduct({
        product: "daily-market-brief",
        id: "daily-market-brief-2026-08-23",
      }),
      product(),
    );
  });
});

test("product replacement is atomic and leaves no temporary files", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const store = createStore(vaultPath);
    await store.initialize();
    await store.writeProduct(product());
    await store.writeProduct(product({ status: "evidence-verified", body: "Updated verified observation." }));

    const actual = await store.readProduct({
      product: "daily-market-brief",
      id: "daily-market-brief-2026-08-23",
    });
    assert.equal(actual.status, "evidence-verified");
    assert.equal(actual.body, "Updated verified observation.");
    const entries = await readdir(join(vaultPath, "30 Products/Daily Market Brief"));
    assert.equal(entries.some((entry) => entry.includes(".tmp-")), false);
  });
});

test("source evidence identities are immutable and idempotent", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const store = createStore(vaultPath);
    await store.initialize();
    const source = {
      id: "source-fed-2026-08-23",
      title: "Federal Reserve official release",
      url: "https://www.federalreserve.gov/example",
      tier: "official",
      observedAt: "2026-08-23T08:00:00.000Z",
    };

    const first = await store.writeSource(source);
    const second = await store.writeSource({ ...source });
    assert.equal(first.relativePath, second.relativePath);
    assert.equal(second.unchanged, true);
    await assert.rejects(
      store.writeSource({ ...source, title: "Conflicting replacement" }),
      /immutable evidence conflict/i,
    );
    assert.equal((await readdir(join(vaultPath, "10 Sources"))).filter((name) => name.endsWith(".md")).length, 2);
  });
});

test("concurrent immutable evidence with one identity permits exactly one payload", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const store = createStore(vaultPath);
    await store.initialize();
    const candidates = Array.from({ length: 32 }, (_, index) => ({
      id: "source-concurrent-release",
      title: `Official release candidate ${index}`,
      url: `https://official.example/release/${index}`,
      tier: "official",
      observedAt: "2026-08-23T08:00:00.000Z",
    }));

    const settled = await Promise.allSettled(candidates.map((candidate) => store.writeSource(candidate)));
    assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(settled.filter(({ status }) => status === "rejected").length, candidates.length - 1);
  });
});

test("callers cannot escape governed folders with traversal-like identifiers", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const store = createStore(vaultPath);
    await store.initialize();

    for (const id of ["../outside", "nested/file", "nested\\file", ".", "..", "/absolute"]) {
      await assert.rejects(store.writeProduct(product({ id })), /invalid note id/i);
    }
    await assert.rejects(
      store.readProduct({ product: "../../outside", id: "safe-id" }),
      /unsupported product/i,
    );
  });
});

test("vault operations fail closed when a governed path becomes a symlink", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const outside = join(directory, "outside");
    const store = createStore(vaultPath);
    await store.initialize();
    await mkdir(outside);
    const governedDirectory = join(vaultPath, "30 Products/Daily Market Brief");
    await rm(governedDirectory, { recursive: true });
    await symlink(outside, governedDirectory, "dir");

    await assert.rejects(store.writeProduct(product()), /symbolic link|vault boundary/i);
    assert.deepEqual(await readdir(outside), []);
    const health = await store.health();
    assert.equal(health.ready, false);
    assert.equal(health.writable, false);
  });
});

test("a vault root supplied through a symlink is rejected", async () => {
  await withTemporaryDirectory(async (directory) => {
    const actualVault = join(directory, "actual-vault");
    const linkedVault = join(directory, "linked-vault");
    await mkdir(actualVault);
    await symlink(actualVault, linkedVault, "dir");

    await assert.rejects(createStore(linkedVault).initialize(), /symbolic link|vault boundary/i);
  });
});

test("a vault whose ancestor is a symlink is rejected before initialization", async () => {
  await withTemporaryDirectory(async (directory) => {
    const outside = join(directory, "outside");
    const linkedParent = join(directory, "linked-parent");
    await mkdir(outside);
    await symlink(outside, linkedParent, "dir");

    await assert.rejects(
      createStore(join(linkedParent, "vault")).initialize(),
      /symbolic link|vault boundary/i,
    );
    assert.deepEqual(await readdir(outside), []);
  });
});

test("health rejects a corrupt index even when it contains the schema text", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const store = createStore(vaultPath);
    await store.initialize();
    await writeFile(
      join(vaultPath, "10 Sources/INDEX.md"),
      'garbage schema: "yubit-obsidian-index/v1" without frontmatter',
      "utf8",
    );

    const health = await store.health();
    assert.equal(health.ready, false);
    assert.match(health.error, /malformed vault index/i);
  });
});

test("readProduct rejects queryable frontmatter that disagrees with canonical payload", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const store = createStore(vaultPath);
    await store.initialize();
    const written = await store.writeProduct(product());
    const notePath = join(vaultPath, written.relativePath);
    const markdown = await readFile(notePath, "utf8");
    await writeFile(notePath, markdown.replace('status: "draft"', 'status: "published"'), "utf8");

    await assert.rejects(
      store.readProduct({ product: "daily-market-brief", id: product().id }),
      /frontmatter.*mismatch/i,
    );
  });
});

test("a title containing a JSON fence does not shadow the canonical payload", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const store = createStore(vaultPath);
    await store.initialize();
    const tricky = product({ title: "Observation\n```json\n{}\n```" });
    await store.writeProduct(tricky);

    assert.deepEqual(
      await store.readProduct({ product: tricky.product, id: tricky.id }),
      tricky,
    );
  });
});

test("event, distribution, and feedback notes are governed and canonical", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const store = createStore(vaultPath);
    await store.initialize();
    const event = await store.writeEvent({ id: "event-cpi-2026-08", title: "CPI", status: "scheduled" });
    const distributionPayload = { id: "delivery-1", status: "delivered", platform: "telegram", messageIds: ["2", "1"] };
    const firstDistribution = await store.writeDistribution(distributionPayload);
    const secondDistribution = await store.writeDistribution({ messageIds: ["2", "1"], platform: "telegram", status: "delivered", id: "delivery-1" });
    const feedback = await store.writeFeedback({ id: "feedback-daily", status: "current", impressions: 12 });

    assert.equal(event.relativePath, "20 Events/event-cpi-2026-08.md");
    assert.equal(firstDistribution.contentHash, secondDistribution.contentHash);
    assert.equal(secondDistribution.unchanged, true);
    assert.equal(feedback.relativePath, "50 Feedback/feedback-daily.md");
  });
});

test("readProduct rejects malformed, mismatched, and tampered notes", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const store = createStore(vaultPath);
    await store.initialize();
    const notePath = join(vaultPath, "30 Products/Daily Market Brief/daily-market-brief-2026-08-23.md");
    await writeFile(notePath, "not a governed note\n", "utf8");
    await assert.rejects(
      store.readProduct({ product: "daily-market-brief", id: "daily-market-brief-2026-08-23" }),
      /malformed obsidian note/i,
    );

    const valid = await store.writeProduct(product());
    const markdown = await readFile(join(vaultPath, valid.relativePath), "utf8");
    await writeFile(join(vaultPath, valid.relativePath), markdown.replace("BTC held", "ETH held"), "utf8");
    await assert.rejects(
      store.readProduct({ product: "daily-market-brief", id: "daily-market-brief-2026-08-23" }),
      /content hash mismatch/i,
    );
  });
});

test("concurrent replacements always leave one complete canonical product note", async () => {
  await withTemporaryDirectory(async (directory) => {
    const vaultPath = join(directory, "vault");
    const store = createStore(vaultPath);
    await store.initialize();
    const bodies = Array.from({ length: 24 }, (_, index) => `Complete revision ${index}`);

    await Promise.all(bodies.map((body) => store.writeProduct(product({ body }))));

    const actual = await store.readProduct({
      product: "daily-market-brief",
      id: "daily-market-brief-2026-08-23",
    });
    assert.ok(bodies.includes(actual.body));
    const directoryEntries = await readdir(dirname(join(vaultPath, "30 Products/Daily Market Brief/x")));
    assert.equal(directoryEntries.some((entry) => entry.includes(".tmp-")), false);
  });
});
