import { createHash, randomUUID } from "node:crypto";
import {
  access,
  constants,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const NOTE_SCHEMA = "yubit-obsidian-note/v1";
const INDEX_SCHEMA = "yubit-obsidian-index/v1";
const PAYLOAD_SENTINEL = "<!-- yubit-canonical-payload:v1 -->";

export const OBSIDIAN_VAULT_DIRECTORIES = Object.freeze([
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
]);

export const OBSIDIAN_PRODUCT_DIRECTORIES = Object.freeze({
  "daily-market-brief": "30 Products/Daily Market Brief",
  "weekly-catalyst-calendar": "30 Products/Weekly Catalyst Calendar",
  "data-flash": "30 Products/Data Flash",
  "market-follow-up": "30 Products/Market Follow-up",
});

const DIRECTORY_TITLES = Object.freeze({
  "00 System": "System",
  "10 Sources": "Sources",
  "20 Events": "Events",
  "30 Products": "Products",
  "30 Products/Daily Market Brief": "Daily Market Brief",
  "30 Products/Weekly Catalyst Calendar": "Weekly Catalyst Calendar",
  "30 Products/Data Flash": "Data Flash",
  "30 Products/Market Follow-up": "Market Follow-up",
  "40 Distribution": "Distribution",
  "50 Feedback": "Feedback",
  "90 Archive": "Archive",
  _assets: "Assets",
});

function canonicalize(value, location = "payload") {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${location} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalize(entry, `${location}[${index}]`));
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) {
        throw new TypeError(`${location}.${key} is undefined`);
      }
      result[key] = canonicalize(value[key], `${location}.${key}`);
    }
    return result;
  }
  throw new TypeError(`${location} must contain JSON-compatible values only`);
}

function canonicalJson(payload) {
  return JSON.stringify(canonicalize(payload));
}

function contentHash(payloadJson) {
  return `sha256:${createHash("sha256").update(payloadJson).digest("hex")}`;
}

function yamlScalar(value) {
  return JSON.stringify(value);
}

function assertRecord(record, kind) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError(`${kind} must be an object`);
  }
  assertSafeId(record.id);
}

function assertSafeId(id) {
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 160 ||
    id === "." ||
    id === ".." ||
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)
  ) {
    throw new Error("Invalid note id; use a stable identifier without paths or traversal segments");
  }
}

function productDirectory(product) {
  const directory = OBSIDIAN_PRODUCT_DIRECTORIES[product];
  if (!directory) {
    throw new Error(`Unsupported product: ${String(product)}`);
  }
  return directory;
}

function ensureInside(rootPath, candidatePath) {
  const pathFromRoot = relative(rootPath, candidatePath);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))) {
    return;
  }
  throw new Error("Vault boundary violation");
}

async function pathState(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function frontmatterFields({ kind, payload, hash, timestamp }) {
  return Object.fromEntries(Object.entries({
    schema: NOTE_SCHEMA,
    kind,
    id: payload.id,
    product: kind === "product" ? payload.product : undefined,
    status: payload.status,
    event_id: payload.eventId,
    language: payload.language,
    tier: payload.tier,
    url: payload.url,
    observed_at: payload.observedAt,
    source_count: Array.isArray(payload.sourceRefs) ? payload.sourceRefs.length : undefined,
    content_hash: hash,
    updated_at: timestamp,
  }).filter(([, value]) => value !== undefined));
}

function frontmatterFor(input) {
  return Object.entries(frontmatterFields(input))
    .map(([key, value]) => `${key}: ${yamlScalar(value)}`)
    .join("\n");
}

function renderNote({ kind, payload, timestamp }) {
  const payloadJson = canonicalJson(payload);
  const hash = contentHash(payloadJson);
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : payload.id;
  return {
    hash,
    markdown: `---\n${frontmatterFor({ kind, payload, hash, timestamp })}\n---\n\n# ${title}\n\n${PAYLOAD_SENTINEL}\n\n\`\`\`json\n${payloadJson}\n\`\`\`\n`,
  };
}

function parseFrontmatter(markdown, label) {
  if (typeof markdown !== "string" || !markdown.startsWith("---\n")) {
    throw new Error(`Malformed ${label}: missing frontmatter`);
  }
  const frontmatterEnd = markdown.indexOf("\n---\n", 4);
  if (frontmatterEnd < 0) {
    throw new Error(`Malformed ${label}: unclosed frontmatter`);
  }
  const fields = {};
  for (const line of markdown.slice(4, frontmatterEnd).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Malformed ${label}: invalid frontmatter field`);
    const key = line.slice(0, separator);
    if (Object.hasOwn(fields, key)) throw new Error(`Malformed ${label}: duplicate ${key} field`);
    try {
      fields[key] = JSON.parse(line.slice(separator + 1).trim());
    } catch {
      throw new Error(`Malformed ${label}: invalid ${key} field`);
    }
  }
  return { fields, frontmatterEnd };
}

function parseNote(markdown) {
  const { fields, frontmatterEnd } = parseFrontmatter(markdown, "Obsidian note");
  const marker = `\n${PAYLOAD_SENTINEL}\n\n\`\`\`json\n`;
  const payloadStart = markdown.lastIndexOf(marker);
  const payloadEnd = markdown.length - "\n```\n".length;
  if (payloadStart <= frontmatterEnd || payloadEnd <= payloadStart || !markdown.endsWith("\n```\n")) {
    throw new Error("Malformed Obsidian note: missing canonical JSON payload");
  }
  const payloadJsonText = markdown.slice(payloadStart + marker.length, payloadEnd);
  let payload;
  try {
    payload = JSON.parse(payloadJsonText);
  } catch {
    throw new Error("Malformed Obsidian note: invalid canonical JSON payload");
  }
  const payloadJson = canonicalJson(payload);
  if (payloadJson !== payloadJsonText) {
    throw new Error("Malformed Obsidian note: JSON payload is not canonical");
  }
  if (fields.schema !== NOTE_SCHEMA || typeof fields.kind !== "string" || typeof fields.id !== "string") {
    throw new Error("Malformed Obsidian note: invalid governed metadata");
  }
  if (fields.content_hash !== contentHash(payloadJson)) {
    throw new Error("Content hash mismatch in Obsidian note");
  }
  const timestamp = new Date(fields.updated_at);
  if (typeof fields.updated_at !== "string" || Number.isNaN(timestamp.valueOf()) || timestamp.toISOString() !== fields.updated_at) {
    throw new Error("Malformed Obsidian note: invalid updated_at field");
  }
  const expectedFields = frontmatterFields({
    kind: fields.kind,
    payload,
    hash: contentHash(payloadJson),
    timestamp: fields.updated_at,
  });
  if (canonicalJson(fields) !== canonicalJson(expectedFields)) {
    throw new Error("Obsidian note frontmatter mismatch with canonical payload");
  }
  return { fields, payload };
}

function parseIndex(markdown, relativeDirectory) {
  const { fields, frontmatterEnd } = parseFrontmatter(markdown, "vault index");
  if (
    canonicalJson(fields) !== canonicalJson({ schema: INDEX_SCHEMA, folder: relativeDirectory })
    || !/^\n# .+\n$/.test(markdown.slice(frontmatterEnd + 5))
  ) {
    throw new Error(`Malformed vault index: ${relativeDirectory}`);
  }
}

export function createObsidianContentStore({ vaultPath, now = () => new Date() } = {}) {
  if (typeof vaultPath !== "string" || !isAbsolute(vaultPath)) {
    throw new TypeError("vaultPath must be an absolute path");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }
  const rootPath = resolve(vaultPath);

  async function assertNoSymlinkComponents() {
    const root = parse(rootPath).root;
    let currentPath = root;
    for (const component of rootPath.slice(root.length).split(sep).filter(Boolean)) {
      currentPath = join(currentPath, component);
      const state = await pathState(currentPath);
      if (!state) break;
      if (state.isSymbolicLink()) {
        if (process.platform === "darwin" && currentPath === "/var") continue;
        throw new Error("Vault boundary contains a symbolic link ancestor");
      }
    }
  }

  async function assertRootSafe({ create = false } = {}) {
    await assertNoSymlinkComponents();
    let rootState = await pathState(rootPath);
    if (!rootState && create) {
      await mkdir(rootPath, { recursive: true, mode: 0o750 });
      rootState = await lstat(rootPath);
    }
    if (!rootState) throw new Error("Vault is not initialized");
    if (rootState.isSymbolicLink() || !rootState.isDirectory()) {
      throw new Error("Vault boundary is a symbolic link or is not a directory");
    }
    await assertNoSymlinkComponents();
    const actualRootPath = await realpath(rootPath);
    const expectedRootPath = join(await realpath(dirname(rootPath)), basename(rootPath));
    if (actualRootPath !== expectedRootPath) {
      throw new Error("Vault boundary realpath mismatch");
    }
    return actualRootPath;
  }

  async function assertGovernedDirectory(relativeDirectory, { create = false } = {}) {
    const actualRootPath = await assertRootSafe({ create });
    const components = relativeDirectory.split("/");
    let currentPath = rootPath;
    let expectedActualPath = actualRootPath;
    for (const component of components) {
      currentPath = join(currentPath, component);
      expectedActualPath = join(expectedActualPath, component);
      ensureInside(rootPath, currentPath);
      let state = await pathState(currentPath);
      if (!state && create) {
        await mkdir(currentPath, { mode: 0o750 });
        state = await lstat(currentPath);
      }
      if (!state) throw new Error(`Vault directory is missing: ${relativeDirectory}`);
      if (state.isSymbolicLink() || !state.isDirectory()) {
        throw new Error(`Vault boundary contains a symbolic link: ${relativeDirectory}`);
      }
      const actualPath = await realpath(currentPath);
      ensureInside(actualRootPath, actualPath);
      if (actualPath !== expectedActualPath) {
        throw new Error(`Vault boundary realpath mismatch: ${relativeDirectory}`);
      }
    }
    return currentPath;
  }

  async function assertTargetSafe(relativeDirectory, filename) {
    const directoryPath = await assertGovernedDirectory(relativeDirectory);
    const targetPath = join(directoryPath, filename);
    ensureInside(rootPath, targetPath);
    const state = await pathState(targetPath);
    if (state?.isSymbolicLink()) {
      throw new Error("Vault boundary target is a symbolic link");
    }
    return { directoryPath, targetPath };
  }

  async function atomicWrite(relativeDirectory, filename, markdown) {
    const { directoryPath, targetPath } = await assertTargetSafe(relativeDirectory, filename);
    const temporaryPath = join(directoryPath, `.${filename}.tmp-${process.pid}-${randomUUID()}`);
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o640);
      await handle.writeFile(markdown, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await assertGovernedDirectory(relativeDirectory);
      const targetState = await pathState(targetPath);
      if (targetState?.isSymbolicLink()) {
        throw new Error("Vault boundary target is a symbolic link");
      }
      await rename(temporaryPath, targetPath);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async function atomicCreateImmutable(relativeDirectory, filename, markdown) {
    const { directoryPath, targetPath } = await assertTargetSafe(relativeDirectory, filename);
    const temporaryPath = join(directoryPath, `.${filename}.tmp-${process.pid}-${randomUUID()}`);
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o640);
      await handle.writeFile(markdown, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await assertGovernedDirectory(relativeDirectory);
      try {
        await link(temporaryPath, targetPath);
        return true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const targetState = await lstat(targetPath);
        if (targetState.isSymbolicLink() || !targetState.isFile()) {
          throw new Error("Immutable evidence target is not a regular file");
        }
        return false;
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  function timestamp() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.valueOf())) throw new Error("now returned an invalid date");
    return date.toISOString();
  }

  async function initialize() {
    await assertRootSafe({ create: true });
    for (const relativeDirectory of OBSIDIAN_VAULT_DIRECTORIES) {
      await assertGovernedDirectory(relativeDirectory, { create: true });
      const indexPath = join(rootPath, relativeDirectory, "INDEX.md");
      const indexState = await pathState(indexPath);
      if (indexState?.isSymbolicLink()) {
        throw new Error(`Vault boundary index is a symbolic link: ${relativeDirectory}`);
      }
      if (!indexState) {
        const title = DIRECTORY_TITLES[relativeDirectory];
        const markdown = `---\nschema: ${yamlScalar(INDEX_SCHEMA)}\nfolder: ${yamlScalar(relativeDirectory)}\n---\n\n# ${title}\n`;
        await atomicWrite(relativeDirectory, "INDEX.md", markdown);
      }
    }
    return health();
  }

  async function health() {
    try {
      await assertRootSafe();
      for (const relativeDirectory of OBSIDIAN_VAULT_DIRECTORIES) {
        const directoryPath = await assertGovernedDirectory(relativeDirectory);
        const indexPath = join(directoryPath, "INDEX.md");
        const indexState = await lstat(indexPath);
        if (indexState.isSymbolicLink() || !indexState.isFile()) {
          throw new Error(`Invalid vault index: ${relativeDirectory}`);
        }
        parseIndex(await readFile(indexPath, "utf8"), relativeDirectory);
        await access(directoryPath, constants.R_OK | constants.W_OK);
      }
      return {
        ready: true,
        vaultPath: rootPath,
        checkedDirectories: OBSIDIAN_VAULT_DIRECTORIES.length,
        productDirectories: Object.values(OBSIDIAN_PRODUCT_DIRECTORIES),
        writable: true,
      };
    } catch (error) {
      return {
        ready: false,
        vaultPath: rootPath,
        checkedDirectories: OBSIDIAN_VAULT_DIRECTORIES.length,
        productDirectories: Object.values(OBSIDIAN_PRODUCT_DIRECTORIES),
        writable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function writeGoverned({ kind, relativeDirectory, record, immutable = false }) {
    assertRecord(record, kind);
    const canonicalPayload = canonicalize(record);
    const rendered = renderNote({ kind, payload: canonicalPayload, timestamp: timestamp() });
    const filename = `${canonicalPayload.id}.md`;
    const { targetPath } = await assertTargetSafe(relativeDirectory, filename);
    if (immutable) {
      const created = await atomicCreateImmutable(relativeDirectory, filename, rendered.markdown);
      if (!created) {
        const existing = parseNote(await readFile(targetPath, "utf8"));
        if (existing.fields.kind !== kind || existing.fields.id !== canonicalPayload.id
            || existing.fields.content_hash !== rendered.hash) {
          throw new Error(`Immutable evidence conflict for ${canonicalPayload.id}`);
        }
      }
      return {
        id: canonicalPayload.id,
        kind,
        contentHash: rendered.hash,
        relativePath: `${relativeDirectory}/${filename}`,
        unchanged: !created,
      };
    }
    await atomicWrite(relativeDirectory, filename, rendered.markdown);
    return {
      id: canonicalPayload.id,
      kind,
      contentHash: rendered.hash,
      relativePath: `${relativeDirectory}/${filename}`,
      unchanged: false,
    };
  }

  async function writeSource(record) {
    return writeGoverned({ kind: "source", relativeDirectory: "10 Sources", record, immutable: true });
  }

  async function writeEvent(record) {
    return writeGoverned({ kind: "event", relativeDirectory: "20 Events", record });
  }

  async function writeProduct(record) {
    assertRecord(record, "product");
    const relativeDirectory = productDirectory(record.product);
    return writeGoverned({ kind: "product", relativeDirectory, record });
  }

  async function readProduct({ product, id } = {}) {
    const relativeDirectory = productDirectory(product);
    assertSafeId(id);
    const { targetPath } = await assertTargetSafe(relativeDirectory, `${id}.md`);
    const parsed = parseNote(await readFile(targetPath, "utf8"));
    if (parsed.fields.kind !== "product" || parsed.fields.id !== id || parsed.fields.product !== product) {
      throw new Error("Malformed Obsidian note: product identity mismatch");
    }
    if (parsed.payload.id !== id || parsed.payload.product !== product) {
      throw new Error("Malformed Obsidian note: payload identity mismatch");
    }
    return parsed.payload;
  }

  async function writeDistribution(record) {
    return writeGoverned({ kind: "distribution", relativeDirectory: "40 Distribution", record, immutable: true });
  }

  async function writeFeedback(record) {
    return writeGoverned({ kind: "feedback", relativeDirectory: "50 Feedback", record });
  }

  return Object.freeze({
    initialize,
    health,
    writeSource,
    writeEvent,
    writeProduct,
    readProduct,
    writeDistribution,
    writeFeedback,
  });
}
