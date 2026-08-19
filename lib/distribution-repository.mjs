import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { missingDatabaseMessage, persistentDatabaseConfig } from "./deployment-config.mjs";
import { computeNextRunAt, ensureAutomationNextRunAt, migrateMarketContentRules, normalizeDistributionRule } from "./distribution-domain.mjs";
import { readJson, writeJson } from "./json-store.js";

const localStatePath = "distribution-center.json";
let repositoryPromise;
let localWrite = Promise.resolve();

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function nowIso() {
  return new Date().toISOString();
}

function canonicalDeliveryMessageId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const canonical = value.trim().replace(/^0+(?=\d)/, "");
  return canonical !== "0" ? canonical : null;
}

function canonicalDeliveryMessageIds(values) {
  return (Array.isArray(values) ? values : [values]).map(canonicalDeliveryMessageId).filter(Boolean);
}

function normalizeDeliveryMessagePatch(current, patch) {
  if (!Object.hasOwn(patch, "targetMessageIds") && !Object.hasOwn(patch, "targetMessageId")) return {};
  const supplied = Array.isArray(patch.targetMessageIds) ? patch.targetMessageIds : [patch.targetMessageId];
  const targetMessageIds = canonicalDeliveryMessageIds(supplied);
  return { targetMessageId: targetMessageIds[0] ?? null, targetMessageIds };
}

function expiredAutomationMeta(key, value, nowMs) {
  const safe = ["automation-execution-state-v1:", "automation-target-receipts-v2:", "automation-telemetry-pending-v1:"]
    .some((prefix) => key.startsWith(prefix));
  return safe && value?.expiresAt && Date.parse(value.expiresAt) <= nowMs;
}

function emptyState() {
  return { schemaVersion: 1, rules: [], updates: [], events: [], deliveries: [], mappings: [], meta: {}, updatedAt: null };
}

export class JsonDistributionRepository {
  async readPersistedState() {
    const stored = await readJson(localStatePath, emptyState());
    return {
      ...emptyState(),
      ...stored,
      rules: Array.isArray(stored?.rules) ? stored.rules : [],
      updates: Array.isArray(stored?.updates) ? stored.updates : [],
      events: Array.isArray(stored?.events) ? stored.events : [],
      deliveries: Array.isArray(stored?.deliveries) ? stored.deliveries : [],
      mappings: Array.isArray(stored?.mappings) ? stored.mappings : [],
      meta: stored?.meta && typeof stored.meta === "object" ? stored.meta : {},
    };
  }

  async read() {
    const state = await this.readPersistedState();
    const normalizedRules = (Array.isArray(state.rules) ? state.rules : []).map((stored) => {
      const rule = normalizeDistributionRule(stored);
      if (stored.kind === "automation" && stored.contentType === "whale-signals" && stored.schedulePreset !== "hourly") {
        return { ...rule, schedulePreset: "hourly", nextRunAt: computeNextRunAt("hourly", new Date()).toISOString() };
      }
      return rule;
    });
    state.rules = migrateMarketContentRules(normalizedRules).rules;
    return state;
  }

  async mutate(callback) {
    const run = localWrite.then(async () => {
      const state = await this.readPersistedState();
      const result = await callback(state);
      state.updatedAt = nowIso();
      await writeJson(localStatePath, state);
      return clone(result);
    });
    localWrite = run.catch(() => undefined);
    return run;
  }

  async health() {
    await this.read();
    return { ok: true, driver: "json-local", durable: !process.env.VERCEL };
  }

  async listRules(kind) {
    const state = await this.read();
    return clone(state.rules.filter((rule) => !kind || rule.kind === kind));
  }

  async getRule(id) {
    return clone((await this.read()).rules.find((rule) => rule.id === id) ?? null);
  }

  async saveRule(input) {
    const rule = ensureAutomationNextRunAt(normalizeDistributionRule(input));
    const errors = [];
    return this.mutate((state) => {
      const index = state.rules.findIndex((item) => item.id === rule.id);
      const stamp = nowIso();
      const saved = { ...rule, createdAt: index >= 0 ? state.rules[index].createdAt : stamp, updatedAt: stamp };
      if (index >= 0) state.rules[index] = saved;
      else state.rules.push(saved);
      return { ...saved, errors };
    });
  }

  async deleteRule(id) {
    return this.mutate((state) => {
      const before = state.rules.length;
      state.rules = state.rules.filter((rule) => rule.id !== id);
      return before !== state.rules.length;
    });
  }

  async claimDueAutomationRules(now = new Date(), { limit = 1, leaseMs = 240_000 } = {}) {
    return this.mutate((state) => {
      const due = state.rules
        .filter((rule) => rule.kind === "automation"
          && rule.enabled
          && (!rule.nextRunAt || Date.parse(rule.nextRunAt) <= now.getTime())
          && (!rule.leaseUntil || Date.parse(rule.leaseUntil) <= now.getTime()))
        .sort((left, right) => (Date.parse(left.nextRunAt || 0) || 0) - (Date.parse(right.nextRunAt || 0) || 0))
        .slice(0, Math.max(1, Number(limit) || 1));
      const leaseUntil = new Date(now.getTime() + Math.max(1, Number(leaseMs) || 240_000)).toISOString();
      for (const rule of due) {
        rule.status = "running";
        rule.leaseUntil = leaseUntil;
        rule.updatedAt = nowIso();
      }
      return due.map((rule) => clone(rule));
    });
  }

  async claimUpdate(updateId) {
    return this.mutate((state) => {
      const key = String(updateId);
      if (state.updates.includes(key)) return false;
      state.updates.push(key);
      if (state.updates.length > 10000) state.updates = state.updates.slice(-10000);
      return true;
    });
  }

  async releaseUpdate(updateId) {
    return this.mutate((state) => {
      state.updates = state.updates.filter((key) => key !== String(updateId));
    });
  }

  async createEvent(event) {
    return this.mutate((state) => {
      const existing = event.updateId == null ? null : state.events.find((row) => row.ruleId === event.ruleId && String(row.updateId) === String(event.updateId));
      if (existing) return existing;
      const row = { id: event.id ?? randomUUID(), createdAt: nowIso(), ...clone(event) };
      state.events.push(row);
      return row;
    });
  }

  async getEvent(id) {
    return clone((await this.read()).events.find((event) => event.id === id) ?? null);
  }

  async findEventBySource({ ruleId, sourceChatId, sourceMessageId }) {
    return clone((await this.read()).events.find((event) => event.ruleId === ruleId
      && String(event.sourceChatId) === String(sourceChatId)
      && Number(event.sourceMessageId) === Number(sourceMessageId)) ?? null);
  }

  async updateEvent(id, patch) {
    return this.mutate((state) => {
      const index = state.events.findIndex((event) => event.id === id);
      if (index < 0) return null;
      state.events[index] = { ...state.events[index], ...clone(patch), updatedAt: nowIso() };
      return state.events[index];
    });
  }

  async claimReviewEvent(id) {
    return this.mutate((state) => {
      const index = state.events.findIndex((event) => event.id === id);
      if (index < 0 || state.events[index].reviewStatus !== "pending") return null;
      if (state.events[index].expiresAt && Date.parse(state.events[index].expiresAt) <= Date.now()) {
        state.events[index] = { ...state.events[index], reviewStatus: "expired", updatedAt: nowIso() };
        return null;
      }
      state.events[index] = { ...state.events[index], reviewStatus: "approved", reviewedAt: nowIso(), updatedAt: nowIso() };
      return state.events[index];
    });
  }

  async listReviewQueue({ status = "pending", limit = 100 } = {}) {
    const events = (await this.read()).events;
    return clone(events.filter((event) => !status || event.reviewStatus === status).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit));
  }

  async listMediaGroupEvents({ ruleId, sourceChatId, mediaGroupId }) {
    const events = (await this.read()).events;
    return clone(events.filter((event) => event.ruleId === ruleId
      && String(event.sourceChatId) === String(sourceChatId)
      && String(event.mediaGroupId) === String(mediaGroupId))
      .sort((a, b) => Number(a.sourceMessageId) - Number(b.sourceMessageId)));
  }

  async createDelivery(delivery) {
    return this.mutate((state) => {
      const existing = state.deliveries.find((row) => row.eventId === delivery.eventId && row.targetId === delivery.targetId);
      if (existing) return existing;
      const row = { id: delivery.id ?? randomUUID(), status: "pending", attempts: 0, createdAt: nowIso(), ...clone(delivery) };
      state.deliveries.push(row);
      return row;
    });
  }

  async getDelivery(id) {
    return clone((await this.read()).deliveries.find((delivery) => delivery.id === id) ?? null);
  }

  async updateDelivery(id, patch) {
    return this.mutate((state) => {
      const index = state.deliveries.findIndex((delivery) => delivery.id === id);
      if (index < 0) return null;
      state.deliveries[index] = {
        ...state.deliveries[index], ...clone(patch),
        ...normalizeDeliveryMessagePatch(state.deliveries[index], patch), updatedAt: nowIso()
      };
      return state.deliveries[index];
    });
  }

  async claimDelivery(id) {
    return this.mutate((state) => {
      const index = state.deliveries.findIndex((delivery) => delivery.id === id);
      if (index < 0 || !["pending", "failed"].includes(state.deliveries[index].status)) return null;
      state.deliveries[index] = { ...state.deliveries[index], status: "sending", updatedAt: nowIso() };
      return state.deliveries[index];
    });
  }

  async listDeliveries({ limit = 200, status = "" } = {}) {
    const rows = (await this.read()).deliveries;
    return clone(rows.filter((row) => !status || row.status === status).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit));
  }

  async saveMapping(mapping) {
    return this.mutate((state) => {
      const key = mappingKey(mapping);
      const index = state.mappings.findIndex((row) => mappingKey(row) === key);
      if (index >= 0) state.mappings[index] = clone(mapping);
      else state.mappings.push(clone(mapping));
      return mapping;
    });
  }

  async findMapping(query) {
    return clone((await this.read()).mappings.find((row) => mappingKey(row) === mappingKey(query)) ?? null);
  }

  async getMeta(key) {
    return clone((await this.read()).meta[key] ?? null);
  }

  async setMeta(key, value) {
    return this.mutate((state) => {
      state.meta[key] = clone(value);
      return value;
    });
  }

  async compareAndSetMeta(key, expected, value) {
    return this.mutate((state) => {
      const current = state.meta[key] ?? null;
      if (expected?.absent === true && current !== null) return null;
      if (expected?.absent !== true && Object.entries(expected ?? {})
        .some(([field, expectedValue]) => field !== "absent" && current?.[field] !== expectedValue)) return null;
      state.meta[key] = clone(value);
      return value;
    });
  }

  async deleteMeta(key) {
    return this.mutate((state) => Object.hasOwn(state.meta, key) ? delete state.meta[key] : false);
  }

  async listMetaByPrefix(prefix) {
    const meta = (await this.read()).meta;
    return Object.entries(meta)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value: clone(value) }));
  }

  async acquireMetaLease(key, lease, now = new Date()) {
    return this.mutate((state) => {
      const current = state.meta[key];
      if (current?.leaseUntil && Date.parse(current.leaseUntil) > new Date(now).getTime()) return null;
      state.meta[key] = clone(lease);
      return lease;
    });
  }

  async getMetaLease(key) {
    return this.getMeta(key);
  }

  async renewMetaLease(key, leaseId, leaseUntil) {
    return this.mutate((state) => {
      const current = state.meta[key];
      if (current?.leaseId !== leaseId) return null;
      const renewed = { ...current, leaseUntil };
      state.meta[key] = clone(renewed);
      return renewed;
    });
  }

  async releaseMetaLease(key, leaseId) {
    return this.mutate((state) => {
      if (state.meta[key]?.leaseId !== leaseId) return false;
      delete state.meta[key];
      return true;
    });
  }

  async cleanupExpired(now = new Date()) {
    const nowMs = new Date(now).getTime();
    const logCutoff = nowMs - 30 * 86400000;
    return this.mutate((state) => {
      for (const event of state.events) {
        if (event.reviewStatus === "pending" && event.expiresAt && Date.parse(event.expiresAt) <= nowMs) event.reviewStatus = "expired";
      }
      const removedDeliveries = state.deliveries.filter((row) => Date.parse(row.createdAt || 0) < logCutoff).length;
      state.deliveries = state.deliveries.filter((row) => Date.parse(row.createdAt || 0) >= logCutoff);
      const activeEventIds = new Set(state.deliveries.map((row) => row.eventId));
      state.events = state.events.filter((row) => Date.parse(row.createdAt || 0) >= logCutoff || activeEventIds.has(row.id));
      state.mappings = state.mappings.filter((row) => !row.createdAt || Date.parse(row.createdAt) >= logCutoff);
      for (const [key, value] of Object.entries(state.meta)) {
        if (expiredAutomationMeta(key, value, nowMs)) delete state.meta[key];
      }
      return { expiredAt: new Date(nowMs).toISOString(), removedDeliveries };
    });
  }
}

function mappingKey(value) {
  return [value.ruleId, value.sourceChatId, value.sourceMessageId, value.targetChatId, value.targetThreadId ?? 0].join(":");
}

function rowDistributionTarget(row) {
  if (row.platform === "discord") {
    return {
      id: row.id,
      platform: "discord",
      guildId: row.guild_id,
      channelId: row.channel_id,
      groupName: row.group_name,
      topicName: row.topic_name,
      ctaEnabled: row.cta_enabled === true,
      ctaText: row.cta_text || "",
      ctaUrl: row.cta_url || "",
      enabled: row.enabled !== false,
      order: Number(row.sort_order || 0)
    };
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    chatType: row.chat_type === "channel" ? "channel" : "supergroup",
    threadId: row.thread_id == null ? null : Number(row.thread_id),
    groupName: row.group_name,
    topicName: row.topic_name,
    ctaEnabled: row.cta_enabled === true,
    ctaText: row.cta_text || "",
    ctaUrl: row.cta_url || "",
    enabled: row.enabled !== false,
    order: Number(row.sort_order || 0)
  };
}

function rowRule(row, targets = []) {
  return normalizeDistributionRule({
    id: row.id,
    kind: row.kind,
    name: row.name,
    contentType: row.content_type,
    schedulePreset: row.schedule_preset,
    mode: row.mode,
    source: row.source,
    targets,
    enabled: row.enabled,
    runOnce: row.run_once,
    status: row.status,
    nextRunAt: row.next_run_at,
    leaseUntil: row.lease_until,
    importedFrom: row.imported_from,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function rowEvent(row) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    updateId: row.update_id,
    sourceChatId: row.source_chat_id,
    sourceThreadId: row.source_thread_id == null ? null : Number(row.source_thread_id),
    sourceMessageId: row.source_message_id == null ? null : Number(row.source_message_id),
    mediaGroupId: row.media_group_id,
    eventType: row.event_type,
    payload: row.payload,
    reviewStatus: row.review_status,
    expiresAt: row.expires_at,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowDelivery(row) {
  const targetMessageId = canonicalDeliveryMessageId(row.target_message_id);
  const targetMessageIds = Array.isArray(row.target_message_ids)
    ? canonicalDeliveryMessageIds(row.target_message_ids)
    : (targetMessageId == null ? [] : [targetMessageId]);
  return {
    id: row.id,
    eventId: row.event_id,
    ruleId: row.rule_id,
    targetId: row.target_id,
    target: row.target,
    status: row.status,
    attempts: row.attempts,
    targetMessageId,
    targetMessageIds,
    publisherProgress: Array.isArray(row.publisher_progress) ? row.publisher_progress : [],
    publisherVerification: row.publisher_verification && typeof row.publisher_verification === "object"
      ? row.publisher_verification
      : null,
    payload: row.payload && typeof row.payload === "object" ? row.payload : {},
    error: row.error,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class PostgresDistributionRepository {
  constructor(databaseUrl) {
    this.sql = neon(databaseUrl);
  }

  async initialize() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS distribution_rules (
        id text PRIMARY KEY, kind text NOT NULL, name text NOT NULL, content_type text,
        schedule_preset text, mode text NOT NULL DEFAULT 'automatic', source jsonb,
        enabled boolean NOT NULL DEFAULT true, run_once boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'ready',
        next_run_at timestamptz, lease_until timestamptz, imported_from text, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS distribution_targets (
        id text PRIMARY KEY, rule_id text NOT NULL REFERENCES distribution_rules(id) ON DELETE CASCADE,
        platform text NOT NULL DEFAULT 'telegram', chat_id text, chat_type text NOT NULL DEFAULT 'supergroup', thread_id bigint,
        guild_id text, channel_id text, group_name text, topic_name text,
        cta_enabled boolean NOT NULL DEFAULT false, cta_text text, cta_url text,
        enabled boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0,
        UNIQUE(rule_id, chat_id, thread_id))`,
      `CREATE TABLE IF NOT EXISTS distribution_updates (
        update_id bigint PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS distribution_events (
        id text PRIMARY KEY, rule_id text NOT NULL REFERENCES distribution_rules(id) ON DELETE CASCADE,
        update_id bigint, source_chat_id text NOT NULL, source_thread_id bigint,
        source_message_id bigint, media_group_id text, event_type text NOT NULL,
        payload jsonb NOT NULL, review_status text NOT NULL, expires_at timestamptz,
        reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(rule_id, update_id))`,
      `CREATE TABLE IF NOT EXISTS distribution_deliveries (
        id text PRIMARY KEY, event_id text NOT NULL REFERENCES distribution_events(id) ON DELETE CASCADE,
        rule_id text NOT NULL, target_id text NOT NULL, target jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
        target_message_id text, target_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        publisher_progress jsonb NOT NULL DEFAULT '[]'::jsonb,
        publisher_verification jsonb,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        error text, delivered_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(event_id, target_id))`,
      `CREATE TABLE IF NOT EXISTS distribution_message_mappings (
        rule_id text NOT NULL, source_chat_id text NOT NULL, source_message_id text NOT NULL,
        target_chat_id text NOT NULL, target_thread_id bigint NOT NULL DEFAULT 0,
        target_message_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(rule_id, source_chat_id, source_message_id, target_chat_id, target_thread_id))`,
      `CREATE TABLE IF NOT EXISTS distribution_meta (
        key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE INDEX IF NOT EXISTS distribution_rules_due_idx ON distribution_rules(enabled, next_run_at)`,
      `CREATE INDEX IF NOT EXISTS distribution_events_review_idx ON distribution_events(review_status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS distribution_deliveries_created_idx ON distribution_deliveries(created_at DESC)`
    ];
    for (const statement of statements) await this.sql.query(statement);
    await this.sql.query("ALTER TABLE distribution_rules ADD COLUMN IF NOT EXISTS run_once boolean NOT NULL DEFAULT false");
    await this.sql.query("ALTER TABLE distribution_rules ADD COLUMN IF NOT EXISTS lease_until timestamptz");
    await this.sql.query("ALTER TABLE distribution_targets ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'telegram'");
    await this.sql.query("ALTER TABLE distribution_targets ALTER COLUMN chat_id DROP NOT NULL");
    await this.sql.query("ALTER TABLE distribution_targets ADD COLUMN IF NOT EXISTS chat_type text NOT NULL DEFAULT 'supergroup'");
    await this.sql.query("ALTER TABLE distribution_targets ADD COLUMN IF NOT EXISTS guild_id text");
    await this.sql.query("ALTER TABLE distribution_targets ADD COLUMN IF NOT EXISTS channel_id text");
    await this.sql.query("ALTER TABLE distribution_targets ADD COLUMN IF NOT EXISTS cta_enabled boolean NOT NULL DEFAULT false");
    await this.sql.query("ALTER TABLE distribution_targets ADD COLUMN IF NOT EXISTS cta_text text");
    await this.sql.query("ALTER TABLE distribution_targets ADD COLUMN IF NOT EXISTS cta_url text");
    await this.sql.query("ALTER TABLE distribution_deliveries ADD COLUMN IF NOT EXISTS target_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb");
    await this.sql.query("ALTER TABLE distribution_deliveries ADD COLUMN IF NOT EXISTS publisher_progress jsonb NOT NULL DEFAULT '[]'::jsonb");
    await this.sql.query("ALTER TABLE distribution_deliveries ADD COLUMN IF NOT EXISTS publisher_verification jsonb");
    await this.sql.query("ALTER TABLE distribution_deliveries ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb");
    await this.sql.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='distribution_deliveries' AND column_name='target_message_id' AND data_type <> 'text') THEN
        ALTER TABLE distribution_deliveries ALTER COLUMN target_message_id TYPE text USING target_message_id::text;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='distribution_message_mappings' AND column_name='source_message_id' AND data_type <> 'text') THEN
        ALTER TABLE distribution_message_mappings ALTER COLUMN source_message_id TYPE text USING source_message_id::text;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='distribution_message_mappings' AND column_name='target_message_id' AND data_type <> 'text') THEN
        ALTER TABLE distribution_message_mappings ALTER COLUMN target_message_id TYPE text USING target_message_id::text;
      END IF;
    END $$`);
    await this.sql.query("CREATE UNIQUE INDEX IF NOT EXISTS distribution_targets_route_idx ON distribution_targets(rule_id, chat_id, chat_type, COALESCE(thread_id, 0))");
    await this.sql.query("CREATE UNIQUE INDEX IF NOT EXISTS distribution_targets_discord_route_idx ON distribution_targets(rule_id, guild_id, channel_id) WHERE platform='discord'");
    await this.sql.query(`UPDATE distribution_deliveries
      SET target_message_ids=jsonb_build_array(target_message_id)
      WHERE target_message_id IS NOT NULL AND jsonb_array_length(target_message_ids)=0`);
    await this.sql.query(`UPDATE distribution_rules
      SET schedule_preset='hourly',
        next_run_at=date_trunc('hour',now()) + interval '1 hour',
        updated_at=now()
      WHERE kind='automation' AND content_type='whale-signals'
        AND schedule_preset IS DISTINCT FROM 'hourly'`);
    return this;
  }

  async health() {
    await this.sql.query("SELECT 1 AS ok");
    return { ok: true, driver: "postgres", durable: true };
  }

  async listRules(kind) {
    const rows = kind
      ? await this.sql.query("SELECT * FROM distribution_rules WHERE kind = $1 ORDER BY created_at DESC", [kind])
      : await this.sql.query("SELECT * FROM distribution_rules ORDER BY created_at DESC");
    if (!rows.length) return [];
    const targets = await this.sql.query("SELECT * FROM distribution_targets WHERE rule_id = ANY($1::text[]) ORDER BY sort_order", [rows.map((row) => row.id)]);
    const rules = rows.map((row) => rowRule(row, targets.filter((target) => target.rule_id === row.id).map(rowDistributionTarget)));
    return migrateMarketContentRules(rules).rules.filter((rule) => !kind || rule.kind === kind);
  }

  async getRule(id) {
    const rows = await this.sql.query("SELECT * FROM distribution_rules WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const targets = await this.sql.query("SELECT * FROM distribution_targets WHERE rule_id = $1 ORDER BY sort_order", [id]);
    return rowRule(rows[0], targets.map(rowDistributionTarget));
  }

  async saveRule(input) {
    const rule = ensureAutomationNextRunAt(normalizeDistributionRule(input));
    await this.sql.query(`INSERT INTO distribution_rules
      (id, kind, name, content_type, schedule_preset, mode, source, enabled, run_once, status, next_run_at, imported_from, lease_until)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind,name=EXCLUDED.name,
      content_type=EXCLUDED.content_type,schedule_preset=EXCLUDED.schedule_preset,mode=EXCLUDED.mode,
      source=EXCLUDED.source,enabled=EXCLUDED.enabled,run_once=EXCLUDED.run_once,status=EXCLUDED.status,
      next_run_at=EXCLUDED.next_run_at,imported_from=EXCLUDED.imported_from,
      lease_until=EXCLUDED.lease_until,updated_at=now()`,
    [rule.id, rule.kind, rule.name, rule.contentType, rule.schedulePreset, rule.mode, JSON.stringify(rule.source), rule.enabled, rule.runOnce, rule.status, rule.nextRunAt, rule.importedFrom, rule.leaseUntil]);
    await this.sql.query("DELETE FROM distribution_targets WHERE rule_id = $1", [rule.id]);
    for (const [index, target] of rule.targets.entries()) {
      await this.sql.query(`INSERT INTO distribution_targets
        (id,rule_id,platform,chat_id,chat_type,thread_id,guild_id,channel_id,group_name,topic_name,cta_enabled,cta_text,cta_url,enabled,sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        target.id,
        rule.id,
        target.platform === "discord" ? "discord" : "telegram",
        target.platform === "discord" ? null : target.chatId,
        target.platform === "discord" ? "channel" : (target.chatType || "supergroup"),
        target.platform === "discord" ? null : target.threadId,
        target.platform === "discord" ? target.guildId : null,
        target.platform === "discord" ? target.channelId : null,
        target.groupName,
        target.topicName,
        target.ctaEnabled === true,
        target.ctaText || null,
        target.ctaUrl || null,
        target.enabled,
        index
      ]);
    }
    return this.getRule(rule.id);
  }

  async deleteRule(id) {
    const rows = await this.sql.query("DELETE FROM distribution_rules WHERE id = $1 RETURNING id", [id]);
    return Boolean(rows[0]);
  }

  async claimDueAutomationRules(now = new Date(), { limit = 1, leaseMs = 240_000 } = {}) {
    const leaseUntil = new Date(now.getTime() + Math.max(1, Number(leaseMs) || 240_000)).toISOString();
    const rows = await this.sql.query(`WITH due AS (
      SELECT id FROM distribution_rules
      WHERE kind='automation' AND enabled=true
        AND (next_run_at IS NULL OR next_run_at <= $1::timestamptz)
        AND (lease_until IS NULL OR lease_until <= $1::timestamptz)
      ORDER BY next_run_at NULLS FIRST, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT $2
    )
    UPDATE distribution_rules AS rule
      SET status='running', lease_until = $3, updated_at=now()
      FROM due WHERE rule.id=due.id
      RETURNING rule.*`, [now.toISOString(), Math.max(1, Number(limit) || 1), leaseUntil]);
    if (!rows.length) return [];
    const targets = await this.sql.query("SELECT * FROM distribution_targets WHERE rule_id = ANY($1::text[]) ORDER BY sort_order", [rows.map((row) => row.id)]);
    return rows.map((row) => rowRule(row, targets.filter((target) => target.rule_id === row.id).map(rowDistributionTarget)));
  }

  async claimUpdate(updateId) {
    const rows = await this.sql.query("INSERT INTO distribution_updates(update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id", [updateId]);
    return Boolean(rows[0]);
  }

  async releaseUpdate(updateId) {
    await this.sql.query("DELETE FROM distribution_updates WHERE update_id = $1", [updateId]);
  }

  async createEvent(event) {
    const id = event.id ?? randomUUID();
    const rows = await this.sql.query(`INSERT INTO distribution_events
      (id,rule_id,update_id,source_chat_id,source_thread_id,source_message_id,media_group_id,event_type,payload,review_status,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
      ON CONFLICT(rule_id,update_id) DO UPDATE SET updated_at=distribution_events.updated_at RETURNING *`,
    [id, event.ruleId, event.updateId, event.sourceChatId, event.sourceThreadId, event.sourceMessageId, event.mediaGroupId, event.eventType, JSON.stringify(event.payload), event.reviewStatus, event.expiresAt]);
    return rowEvent(rows[0]);
  }

  async getEvent(id) {
    const rows = await this.sql.query("SELECT * FROM distribution_events WHERE id = $1", [id]);
    return rows[0] ? rowEvent(rows[0]) : null;
  }

  async findEventBySource({ ruleId, sourceChatId, sourceMessageId }) {
    const rows = await this.sql.query(`SELECT * FROM distribution_events
      WHERE rule_id=$1 AND source_chat_id=$2 AND source_message_id=$3
      ORDER BY created_at ASC LIMIT 1`, [ruleId, String(sourceChatId), Number(sourceMessageId)]);
    return rows[0] ? rowEvent(rows[0]) : null;
  }

  async updateEvent(id, patch) {
    const current = await this.getEvent(id);
    if (!current) return null;
    const merged = { ...current, ...patch };
    const rows = await this.sql.query(`UPDATE distribution_events SET review_status=$2,expires_at=$3,reviewed_at=$4,payload=$5::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,
      [id, merged.reviewStatus, merged.expiresAt, merged.reviewedAt, JSON.stringify(merged.payload)]);
    return rowEvent(rows[0]);
  }

  async claimReviewEvent(id) {
    const rows = await this.sql.query(`UPDATE distribution_events SET review_status='approved',reviewed_at=now(),updated_at=now()
      WHERE id=$1 AND review_status='pending' AND (expires_at IS NULL OR expires_at > now()) RETURNING *`, [id]);
    if (rows[0]) return rowEvent(rows[0]);
    await this.sql.query("UPDATE distribution_events SET review_status='expired',updated_at=now() WHERE id=$1 AND review_status='pending' AND expires_at <= now()", [id]);
    return null;
  }

  async listReviewQueue({ status = "pending", limit = 100 } = {}) {
    const rows = status
      ? await this.sql.query("SELECT * FROM distribution_events WHERE review_status=$1 ORDER BY created_at DESC LIMIT $2", [status, limit])
      : await this.sql.query("SELECT * FROM distribution_events ORDER BY created_at DESC LIMIT $1", [limit]);
    return rows.map(rowEvent);
  }

  async listMediaGroupEvents({ ruleId, sourceChatId, mediaGroupId }) {
    const rows = await this.sql.query(`SELECT * FROM distribution_events
      WHERE rule_id=$1 AND source_chat_id=$2 AND media_group_id=$3 ORDER BY source_message_id`,
    [ruleId, String(sourceChatId), String(mediaGroupId)]);
    return rows.map(rowEvent);
  }

  async createDelivery(delivery) {
    const id = delivery.id ?? randomUUID();
    const rows = await this.sql.query(`INSERT INTO distribution_deliveries
      (id,event_id,rule_id,target_id,target,status,attempts,payload) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb)
      ON CONFLICT(event_id,target_id) DO UPDATE SET
        payload=CASE WHEN EXCLUDED.payload = '{}'::jsonb THEN distribution_deliveries.payload ELSE EXCLUDED.payload END,
        updated_at=distribution_deliveries.updated_at RETURNING *`,
      [id, delivery.eventId, delivery.ruleId, delivery.targetId, JSON.stringify(delivery.target), delivery.status ?? "pending", delivery.attempts ?? 0, JSON.stringify(delivery.payload ?? {})]);
    return rowDelivery(rows[0]);
  }

  async getDelivery(id) {
    const rows = await this.sql.query("SELECT * FROM distribution_deliveries WHERE id=$1", [id]);
    return rows[0] ? rowDelivery(rows[0]) : null;
  }

  async updateDelivery(id, patch) {
    const current = await this.getDelivery(id);
    if (!current) return null;
    const merged = { ...current, ...patch };
    const suppliedMessageIds = Array.isArray(patch.targetMessageIds)
      ? patch.targetMessageIds
      : (Object.prototype.hasOwnProperty.call(patch, "targetMessageId")
          ? [patch.targetMessageId]
          : (current.targetMessageIds?.length ? current.targetMessageIds : [current.targetMessageId]));
    const targetMessageIds = canonicalDeliveryMessageIds(suppliedMessageIds);
    const targetMessageId = targetMessageIds[0] ?? null;
    const publisherProgress = Array.isArray(merged.publisherProgress) ? merged.publisherProgress : [];
    const publisherVerification = merged.publisherVerification && typeof merged.publisherVerification === "object"
      ? merged.publisherVerification
      : null;
    const payload = merged.payload && typeof merged.payload === "object" ? merged.payload : {};
    const rows = await this.sql.query(`UPDATE distribution_deliveries SET status=$2,attempts=$3,
      target_message_id=$4,target_message_ids=$5::jsonb,publisher_progress=$6::jsonb,
      publisher_verification=$7::jsonb,payload=$8::jsonb,error=$9,delivered_at=$10,updated_at=now()
      WHERE id=$1 RETURNING *`,
      [
        id,
        merged.status,
        merged.attempts,
        targetMessageId,
        JSON.stringify(targetMessageIds),
        JSON.stringify(publisherProgress),
        JSON.stringify(publisherVerification),
        JSON.stringify(payload),
        merged.error,
        merged.deliveredAt
      ]);
    return rowDelivery(rows[0]);
  }

  async claimDelivery(id) {
    const rows = await this.sql.query(`UPDATE distribution_deliveries SET status='sending',updated_at=now()
      WHERE id=$1 AND status IN ('pending','failed') RETURNING *`, [id]);
    return rows[0] ? rowDelivery(rows[0]) : null;
  }

  async listDeliveries({ limit = 200, status = "" } = {}) {
    const rows = status
      ? await this.sql.query("SELECT * FROM distribution_deliveries WHERE status=$1 ORDER BY created_at DESC LIMIT $2", [status, limit])
      : await this.sql.query("SELECT * FROM distribution_deliveries ORDER BY created_at DESC LIMIT $1", [limit]);
    return rows.map(rowDelivery);
  }

  async saveMapping(mapping) {
    const sourceMessageId = canonicalDeliveryMessageId(mapping.sourceMessageId);
    const targetMessageId = canonicalDeliveryMessageId(mapping.targetMessageId);
    if (!sourceMessageId || !targetMessageId) throw new Error("Invalid distribution mapping message id");
    await this.sql.query(`INSERT INTO distribution_message_mappings
      (rule_id,source_chat_id,source_message_id,target_chat_id,target_thread_id,target_message_id)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(rule_id,source_chat_id,source_message_id,target_chat_id,target_thread_id)
      DO UPDATE SET target_message_id=EXCLUDED.target_message_id`,
    [mapping.ruleId, mapping.sourceChatId, sourceMessageId, mapping.targetChatId, mapping.targetThreadId ?? 0, targetMessageId]);
    return { ...mapping, sourceMessageId, targetMessageId };
  }

  async findMapping(query) {
    const sourceMessageId = canonicalDeliveryMessageId(query.sourceMessageId);
    if (!sourceMessageId) return null;
    const rows = await this.sql.query(`SELECT * FROM distribution_message_mappings WHERE
      rule_id=$1 AND source_chat_id=$2 AND source_message_id=$3 AND target_chat_id=$4 AND target_thread_id=$5`,
    [query.ruleId, query.sourceChatId, sourceMessageId, query.targetChatId, query.targetThreadId ?? 0]);
    if (!rows[0]) return null;
    return { ruleId: rows[0].rule_id, sourceChatId: rows[0].source_chat_id, sourceMessageId: canonicalDeliveryMessageId(rows[0].source_message_id), targetChatId: rows[0].target_chat_id, targetThreadId: Number(rows[0].target_thread_id) || null, targetMessageId: canonicalDeliveryMessageId(rows[0].target_message_id) };
  }

  async getMeta(key) {
    const rows = await this.sql.query("SELECT value FROM distribution_meta WHERE key=$1", [key]);
    return rows[0]?.value ?? null;
  }

  async setMeta(key, value) {
    await this.sql.query(`INSERT INTO distribution_meta(key,value) VALUES($1,$2::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [key, JSON.stringify(value)]);
    return value;
  }

  async compareAndSetMeta(key, expected, value) {
    if (expected?.absent === true) {
      const rows = await this.sql.query(`INSERT INTO distribution_meta(key,value) VALUES($1,$2::jsonb)
        ON CONFLICT(key) DO NOTHING RETURNING value`, [key, JSON.stringify(value)]);
      return rows[0]?.value ?? null;
    }
    const expectedValue = Object.fromEntries(Object.entries(expected ?? {}).filter(([field]) => field !== "absent"));
    const rows = await this.sql.query(`UPDATE distribution_meta SET value=$2::jsonb,updated_at=now()
      WHERE key=$1 AND value @> $3::jsonb RETURNING value`, [key, JSON.stringify(value), JSON.stringify(expectedValue)]);
    return rows[0]?.value ?? null;
  }

  async deleteMeta(key) {
    const rows = await this.sql.query("DELETE FROM distribution_meta WHERE key=$1 RETURNING key", [key]);
    return Boolean(rows[0]);
  }

  async listMetaByPrefix(prefix) {
    const escapedPrefix = String(prefix)
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const rows = await this.sql.query("SELECT key,value FROM distribution_meta WHERE key LIKE $1 ESCAPE E'\\\\' ORDER BY key", [`${escapedPrefix}%`]);
    return rows.map((row) => ({ key: row.key, value: row.value }));
  }

  async acquireMetaLease(key, lease, now = new Date()) {
    const rows = await this.sql.query(`INSERT INTO distribution_meta(key,value) VALUES($1,$2::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
      WHERE NOT (distribution_meta.value ? 'leaseUntil')
        OR (distribution_meta.value->>'leaseUntil')::timestamptz <= $3::timestamptz
      RETURNING value`, [key, JSON.stringify(lease), new Date(now).toISOString()]);
    return rows[0]?.value ?? null;
  }

  async getMetaLease(key) {
    return this.getMeta(key);
  }

  async renewMetaLease(key, leaseId, leaseUntil) {
    const rows = await this.sql.query(`UPDATE distribution_meta
      SET value=jsonb_set(value,'{leaseUntil}',to_jsonb($3::text),true),updated_at=now()
      WHERE key=$1 AND value->>'leaseId'=$2
      RETURNING value`, [key, leaseId, leaseUntil]);
    return rows[0]?.value ?? null;
  }

  async releaseMetaLease(key, leaseId) {
    const rows = await this.sql.query("DELETE FROM distribution_meta WHERE key=$1 AND value->>'leaseId'=$2 RETURNING key", [key, leaseId]);
    return Boolean(rows[0]);
  }

  async cleanupExpired(now = new Date()) {
    const stamp = new Date(now).toISOString();
    await this.sql.query("UPDATE distribution_events SET review_status='expired',updated_at=now() WHERE review_status='pending' AND expires_at <= $1", [stamp]);
    const mappings = await this.sql.query("DELETE FROM distribution_message_mappings WHERE created_at < $1::timestamptz - interval '30 days' RETURNING source_message_id", [stamp]);
    const events = await this.sql.query("DELETE FROM distribution_events WHERE created_at < $1::timestamptz - interval '30 days' RETURNING id", [stamp]);
    await this.sql.query(`DELETE FROM distribution_meta
      WHERE (key LIKE 'automation-execution-state-v1:%'
        OR key LIKE 'automation-target-receipts-v2:%'
        OR key LIKE 'automation-telemetry-pending-v1:%')
        AND value ? 'expiresAt' AND value->>'expiresAt' IS NOT NULL
        AND (value->>'expiresAt')::timestamptz <= $1::timestamptz`, [stamp]);
    return { expiredAt: stamp, removedEvents: events.length, removedMappings: mappings.length };
  }
}

export async function getDistributionRepository() {
  if (!repositoryPromise) {
    repositoryPromise = (async () => {
      const database = persistentDatabaseConfig(process.env);
      if (database.url) return new PostgresDistributionRepository(database.url).initialize();
      const previewBlobFallback = process.env.VERCEL_ENV === "preview"
        && process.env.DISTRIBUTION_ALLOW_JSON_FALLBACK === "true"
        && Boolean(process.env.BLOB_READ_WRITE_TOKEN);
      if (previewBlobFallback) return new JsonDistributionRepository();
      if (process.env.VERCEL || process.env.NODE_ENV === "production") {
        throw new Error(missingDatabaseMessage("内容分发", process.env));
      }
      return new JsonDistributionRepository();
    })();
  }
  return repositoryPromise;
}

export function resetDistributionRepositoryForTests() {
  repositoryPromise = undefined;
}
