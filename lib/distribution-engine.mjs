function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export class MemoryDistributionRepository {
  constructor(seed = {}) {
    this.rules = clone(seed.rules ?? []);
    this.updates = new Set(seed.updates ?? []);
    this.events = clone(seed.events ?? []);
    this.deliveries = clone(seed.deliveries ?? []);
    this.mappings = clone(seed.mappings ?? []);
    this.sequence = this.events.length + this.deliveries.length;
  }

  async listRules(kind) {
    return clone(this.rules.filter((rule) => !kind || rule.kind === kind));
  }

  async getRule(id) {
    return clone(this.rules.find((rule) => rule.id === id) ?? null);
  }

  async claimUpdate(updateId) {
    const key = String(updateId);
    if (this.updates.has(key)) return false;
    this.updates.add(key);
    return true;
  }

  async releaseUpdate(updateId) {
    this.updates.delete(String(updateId));
  }

  async createEvent(event) {
    const existing = this.events.find((item) => item.ruleId === event.ruleId && String(item.updateId) === String(event.updateId));
    if (existing) return clone(existing);
    const row = { id: event.id ?? `event-${++this.sequence}`, createdAt: new Date().toISOString(), ...clone(event) };
    this.events.push(row);
    return clone(row);
  }

  async getEvent(id) {
    return clone(this.events.find((item) => item.id === id) ?? null);
  }

  async findEventBySource({ ruleId, sourceChatId, sourceMessageId }) {
    return clone(this.events.find((item) => item.ruleId === ruleId
      && String(item.sourceChatId) === String(sourceChatId)
      && Number(item.sourceMessageId) === Number(sourceMessageId)) ?? null);
  }

  async updateEvent(id, patch) {
    const index = this.events.findIndex((item) => item.id === id);
    if (index < 0) return null;
    this.events[index] = { ...this.events[index], ...clone(patch), updatedAt: new Date().toISOString() };
    return clone(this.events[index]);
  }

  async claimReviewEvent(id) {
    const index = this.events.findIndex((item) => item.id === id);
    if (index < 0 || this.events[index].reviewStatus !== "pending") return null;
    if (this.events[index].expiresAt && Date.parse(this.events[index].expiresAt) <= Date.now()) {
      this.events[index] = { ...this.events[index], reviewStatus: "expired", updatedAt: new Date().toISOString() };
      return null;
    }
    this.events[index] = { ...this.events[index], reviewStatus: "approved", reviewedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    return clone(this.events[index]);
  }

  async listReviewQueue() {
    const now = Date.now();
    return clone(this.events.filter((event) => event.reviewStatus === "pending" && (!event.expiresAt || Date.parse(event.expiresAt) > now)));
  }

  async listMediaGroupEvents({ ruleId, sourceChatId, mediaGroupId }) {
    return clone(this.events.filter((event) => event.ruleId === ruleId
      && String(event.sourceChatId) === String(sourceChatId)
      && String(event.mediaGroupId) === String(mediaGroupId))
      .sort((a, b) => Number(a.sourceMessageId) - Number(b.sourceMessageId)));
  }

  async createDelivery(delivery) {
    const existing = this.deliveries.find((item) => item.eventId === delivery.eventId && item.targetId === delivery.targetId);
    if (existing) return clone(existing);
    const row = { id: delivery.id ?? `delivery-${++this.sequence}`, status: "pending", attempts: 0, ...clone(delivery), createdAt: new Date().toISOString() };
    this.deliveries.push(row);
    return clone(row);
  }

  async getDelivery(id) {
    return clone(this.deliveries.find((item) => item.id === id) ?? null);
  }

  async updateDelivery(id, patch) {
    const index = this.deliveries.findIndex((item) => item.id === id);
    if (index < 0) return null;
    this.deliveries[index] = { ...this.deliveries[index], ...clone(patch), updatedAt: new Date().toISOString() };
    return clone(this.deliveries[index]);
  }

  async claimDelivery(id) {
    const index = this.deliveries.findIndex((item) => item.id === id);
    if (index < 0 || !["pending", "failed"].includes(this.deliveries[index].status)) return null;
    this.deliveries[index] = { ...this.deliveries[index], status: "sending", updatedAt: new Date().toISOString() };
    return clone(this.deliveries[index]);
  }

  async listDeliveries() {
    return clone(this.deliveries);
  }

  async saveMapping(mapping) {
    const index = this.mappings.findIndex((item) => item.ruleId === mapping.ruleId
      && item.sourceChatId === mapping.sourceChatId
      && Number(item.sourceMessageId) === Number(mapping.sourceMessageId)
      && item.targetChatId === mapping.targetChatId
      && Number(item.targetThreadId ?? 0) === Number(mapping.targetThreadId ?? 0));
    if (index >= 0) this.mappings[index] = clone(mapping);
    else this.mappings.push(clone(mapping));
    return clone(mapping);
  }

  async findMapping(query) {
    return clone(this.mappings.find((item) => item.ruleId === query.ruleId
      && item.sourceChatId === query.sourceChatId
      && Number(item.sourceMessageId) === Number(query.sourceMessageId)
      && item.targetChatId === query.targetChatId
      && Number(item.targetThreadId ?? 0) === Number(query.targetThreadId ?? 0)) ?? null);
  }
}

function updateMessage(update) {
  if (update.edited_message) return { message: update.edited_message, edited: true };
  if (update.edited_channel_post) return { message: update.edited_channel_post, edited: true };
  if (update.message) return { message: update.message, edited: false };
  if (update.channel_post) return { message: update.channel_post, edited: false };
  return { message: null, edited: false };
}

function sourceMatches(rule, message) {
  if (!rule.enabled || rule.kind !== "broadcast") return false;
  if (String(rule.source?.chatId) !== String(message.chat?.id)) return false;
  if (rule.source?.chatType === "channel") return message.chat?.type === "channel";
  const configuredThread = Number(rule.source?.threadId ?? 0);
  return configuredThread > 0 && configuredThread === Number(message.message_thread_id ?? 0);
}

function isCopyableMessage(message) {
  return typeof message.text === "string"
    || Boolean(message.photo || message.video || message.document || message.audio || message.voice
      || message.animation || message.sticker || message.poll || message.contact || message.location
      || message.venue || message.dice || message.game || message.video_note || message.paid_media);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class DistributionEngine {
  constructor({
    repository,
    telegram,
    forwardBotId = "",
    mediaGroupDelayMs = 700,
    targetFilter = null,
    deferDelivery = false,
    deliveryPlanBuilder = null
  } = {}) {
    if (!repository) throw new TypeError("repository is required");
    if (typeof telegram !== "function") throw new TypeError("telegram is required");
    this.repository = repository;
    this.telegram = telegram;
    this.forwardBotId = String(forwardBotId || "");
    this.mediaGroupDelayMs = Math.max(0, Number(mediaGroupDelayMs) || 0);
    this.targetFilter = typeof targetFilter === "function" ? targetFilter : () => true;
    this.deferDelivery = deferDelivery === true;
    this.deliveryPlanBuilder = typeof deliveryPlanBuilder === "function" ? deliveryPlanBuilder : null;
  }

  async receiveUpdate(update) {
    if (!Number.isSafeInteger(Number(update?.update_id))) return { status: "ignored", reason: "invalid-update" };
    if (!(await this.repository.claimUpdate(update.update_id))) return { status: "duplicate" };
    try {
      return await this.processClaimedUpdate(update);
    } catch (error) {
      await this.repository.releaseUpdate(update.update_id);
      throw error;
    }
  }

  async processClaimedUpdate(update) {
    const { message, edited } = updateMessage(update);
    if (!message?.chat?.id || !message?.message_id) return { status: "ignored", reason: "unsupported-update" };
    if (this.forwardBotId && String(message.from?.id ?? message.sender_chat?.id ?? "") === this.forwardBotId) {
      return { status: "ignored", reason: "forward-loop" };
    }
    if (!edited && !isCopyableMessage(message)) return { status: "ignored", reason: "unsupported-message" };

    const rules = (await this.repository.listRules("broadcast")).filter((rule) => sourceMatches(rule, message));
    if (!rules.length) return { status: "ignored", reason: "no-matching-rule" };
    const statuses = [];
    for (const rule of rules) {
      const event = await this.repository.createEvent({
        ruleId: rule.id,
        updateId: update.update_id,
        sourceChatId: String(message.chat.id),
        sourceThreadId: message.message_thread_id ?? null,
        sourceMessageId: message.message_id,
        mediaGroupId: message.media_group_id ?? null,
        eventType: edited ? "edited" : "message",
        payload: clone(message),
        reviewStatus: edited ? "not-required" : rule.mode === "review" ? "pending" : "automatic",
        expiresAt: rule.mode === "review" ? new Date(Date.now() + 7 * 86400000).toISOString() : null
      });
      if (edited) {
        await this.syncEdit(rule, event);
        statuses.push("processed");
      } else if (event.mediaGroupId) {
        if (this.mediaGroupDelayMs) await new Promise((resolve) => setTimeout(resolve, this.mediaGroupDelayMs));
        const group = await this.repository.listMediaGroupEvents({ ruleId: rule.id, sourceChatId: event.sourceChatId, mediaGroupId: event.mediaGroupId });
        const leader = group[0];
        if (!leader || leader.id !== event.id) {
          await this.repository.updateEvent(event.id, { reviewStatus: "grouped" });
          statuses.push("processed");
          continue;
        }
        const messageIds = group.map((item) => Number(item.sourceMessageId)).sort((a, b) => a - b);
        const groupedEvent = await this.repository.updateEvent(event.id, { payload: { ...event.payload, _mediaGroupMessageIds: messageIds } });
        for (const item of group.slice(1)) await this.repository.updateEvent(item.id, { reviewStatus: "grouped" });
        if (rule.mode === "review") statuses.push("pending-review");
        else {
          await this.deliverEvent(rule, groupedEvent);
          statuses.push("processed");
        }
      } else if (rule.mode === "review") {
        statuses.push("pending-review");
      } else {
        await this.deliverEvent(rule, event);
        statuses.push("processed");
      }
    }
    return { status: statuses.includes("pending-review") ? "pending-review" : "processed" };
  }

  async approve(eventId) {
    const event = await this.repository.getEvent(eventId);
    if (!event) throw new Error("Review event not found");
    if (event.reviewStatus === "approved" || event.reviewStatus === "delivered") return event;
    if (event.reviewStatus !== "pending") throw new Error("Review event is no longer pending");
    const claimed = await this.repository.claimReviewEvent(event.id);
    if (!claimed) {
      const current = await this.repository.getEvent(event.id);
      if (current?.reviewStatus === "expired") throw new Error("Review event has expired");
      return current;
    }
    const rule = await this.repository.getRule(claimed.ruleId);
    if (!rule) throw new Error("Distribution rule not found");
    await this.deliverEvent(rule, claimed);
    return this.repository.updateEvent(claimed.id, { reviewStatus: "delivered" });
  }

  async reject(eventId) {
    const event = await this.repository.getEvent(eventId);
    if (!event) throw new Error("Review event not found");
    if (event.reviewStatus !== "pending") return event;
    return this.repository.updateEvent(event.id, { reviewStatus: "rejected", reviewedAt: new Date().toISOString() });
  }

  async deliverEvent(rule, event) {
    const results = [];
    const targets = (rule.targets ?? []).filter((item) => item.enabled !== false && this.targetFilter(item));
    if (this.deferDelivery) {
      if (!this.deliveryPlanBuilder) throw new Error("Deferred delivery requires a delivery plan builder");
      const deliveryPlans = [];
      for (const target of targets) {
        const plan = await this.deliveryPlanBuilder(event, target, rule);
        if (!plan?.steps?.length) throw new Error("Deferred delivery plan is empty");
        deliveryPlans.push({ target: clone(target), steps: clone(plan.steps) });
      }
      event = await this.repository.updateEvent(event.id, {
        payload: { ...event.payload, deliveryPlans }
      });
    }
    for (const target of targets) {
      const delivery = await this.repository.createDelivery({
        eventId: event.id,
        ruleId: rule.id,
        targetId: target.id,
        target: clone(target),
        status: "pending",
        attempts: 0
      });
      if (delivery.status === "success") {
        results.push(delivery);
        continue;
      }
      if (this.deferDelivery) {
        results.push(delivery);
        continue;
      }
      results.push(await this.sendDelivery(rule, event, delivery, target));
    }
    return results;
  }

  async sendDelivery(rule, event, delivery, target) {
    const existingMapping = await this.repository.findMapping({
      ruleId: rule.id,
      sourceChatId: event.sourceChatId,
      sourceMessageId: event.sourceMessageId,
      targetChatId: String(target.chatId),
      targetThreadId: target.threadId ?? null
    });
    if (existingMapping?.targetMessageId) {
      return this.repository.updateDelivery(delivery.id, {
        status: "success",
        attempts: Number(delivery.attempts ?? 0),
        targetMessageId: Number(existingMapping.targetMessageId),
        error: null,
        deliveredAt: new Date().toISOString()
      });
    }
    const claimed = await this.repository.claimDelivery(delivery.id);
    if (!claimed) return this.repository.getDelivery(delivery.id);
    const mediaGroupMessageIds = event.payload?._mediaGroupMessageIds;
    const isMediaGroup = Array.isArray(mediaGroupMessageIds) && mediaGroupMessageIds.length > 1;
    const payload = {
      chat_id: String(target.chatId),
      from_chat_id: String(event.sourceChatId),
      ...(isMediaGroup ? { message_ids: mediaGroupMessageIds.map(Number) } : { message_id: Number(event.sourceMessageId) })
    };
    if (target.threadId) payload.message_thread_id = Number(target.threadId);
    const replySourceId = event.payload?.reply_to_message?.message_id;
    if (replySourceId) {
      const parent = await this.repository.findMapping({
        ruleId: rule.id,
        sourceChatId: event.sourceChatId,
        sourceMessageId: replySourceId,
        targetChatId: String(target.chatId),
        targetThreadId: target.threadId ?? null
      });
      if (parent?.targetMessageId) payload.reply_parameters = { message_id: Number(parent.targetMessageId) };
    }
    try {
      const result = await this.telegram(isMediaGroup ? "copyMessages" : "copyMessage", payload);
      const copied = isMediaGroup ? result : [result];
      const sourceIds = isMediaGroup ? mediaGroupMessageIds : [event.sourceMessageId];
      for (const [index, sourceMessageId] of sourceIds.entries()) {
        const targetMessageId = Number(copied[index]?.message_id ?? copied[index]);
        if (!targetMessageId) continue;
        await this.repository.saveMapping({
          ruleId: rule.id,
          sourceChatId: event.sourceChatId,
          sourceMessageId,
          targetChatId: String(target.chatId),
          targetThreadId: target.threadId ?? null,
          targetMessageId
        });
      }
      const targetMessageId = Number(copied[0]?.message_id ?? copied[0]);
      return this.repository.updateDelivery(delivery.id, {
        status: "success",
        attempts: Number(claimed.attempts ?? 0) + 1,
        targetMessageId,
        error: null,
        deliveredAt: new Date().toISOString()
      });
    } catch (error) {
      return this.repository.updateDelivery(delivery.id, {
        status: "failed",
        attempts: Number(claimed.attempts ?? 0) + 1,
        error: errorMessage(error)
      });
    }
  }

  async retryDelivery(deliveryId) {
    const delivery = await this.repository.getDelivery(deliveryId);
    if (!delivery) throw new Error("Delivery not found");
    if (delivery.status !== "failed") return delivery;
    const event = await this.repository.getEvent(delivery.eventId);
    const rule = await this.repository.getRule(delivery.ruleId ?? event?.ruleId);
    if (!event || !rule) throw new Error("Delivery context not found");
    if (!this.targetFilter(delivery.target)) throw new Error("DEMO_ONLY_TEST_POLICY");
    return this.sendDelivery(rule, event, delivery, delivery.target);
  }

  async syncEdit(rule, event) {
    const message = event.payload;
    const method = typeof message.text === "string" ? "editMessageText" : typeof message.caption === "string" ? "editMessageCaption" : null;
    if (!method) return [];
    const results = [];
    for (const target of (rule.targets ?? []).filter((item) => item.enabled !== false && this.targetFilter(item))) {
      const mapping = await this.repository.findMapping({
        ruleId: rule.id,
        sourceChatId: event.sourceChatId,
        sourceMessageId: event.sourceMessageId,
        targetChatId: String(target.chatId),
        targetThreadId: target.threadId ?? null
      });
      if (!mapping) continue;
      const payload = { chat_id: String(target.chatId), message_id: Number(mapping.targetMessageId) };
      if (method === "editMessageText") payload.text = message.text;
      else payload.caption = message.caption;
      if (message.entities) payload.entities = message.entities;
      if (message.caption_entities) payload.caption_entities = message.caption_entities;
      try {
        await this.telegram(method, payload);
        results.push({ status: "success", targetId: target.id });
      } catch (error) {
        results.push({ status: "failed", targetId: target.id, error: errorMessage(error) });
      }
    }
    return results;
  }
}
