import { createObsidianContentStore } from "../lib/obsidian-content-store.mjs";

async function main() {
  const vaultPath = process.argv[2] || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    throw new Error("OBSIDIAN_VAULT_PATH or an absolute vault path argument is required");
  }
  const store = createObsidianContentStore({ vaultPath });
  const result = await store.initialize();
  if (!result.ready) {
    throw new Error(result.error || "Content vault is not ready");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
