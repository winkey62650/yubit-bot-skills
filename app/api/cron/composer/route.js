import { NextResponse } from "next/server";
import { readJson, writeJson } from "../../../../lib/json-store.js";
import { telegramMtprotoCall } from "../../../../lib/telegram-mtproto.mjs";
import { CustomFile } from "teleproto/client/uploads.js";
import { randomUUID } from "node:crypto";
import { assertAccountCanSendToTargets } from "../../../../lib/telegram-composer-targets.mjs";
import { hydrateTelegramTopicAvailability, topicIdsByChatFromTargets } from "../../../../lib/telegram-topic-availability.mjs";
import { sendTelegramPreservingClosedTopic } from "../../../../lib/telegram-delivery.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const QUEUE_FILE = "composer-queue.json";

export async function GET(request) {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = await readJson(QUEUE_FILE, { messages: [] });
    const messages = Array.isArray(data.messages) ? data.messages : [];

    const now = new Date();
    const due = messages.filter(m =>
      m.status === "pending" &&
      (!m.scheduledAt || new Date(m.scheduledAt) <= now)
    );

    if (due.length === 0) {
      return NextResponse.json({ ok: true, processed: 0, remaining: messages.filter(m => m.status === "pending").length });
    }

    // Process one message at a time to stay within rate limits
    const msg = due[0];
    const results = [];
    const errors = [];

    // Reconstruct files from base64 if present
    const processedFiles = [];
    if (Array.isArray(msg.mediaFiles)) {
      for (const mf of msg.mediaFiles) {
        if (mf.base64Data) {
          const buffer = Buffer.from(mf.base64Data, "base64");
          processedFiles.push({
            customFile: new CustomFile(mf.fileMeta.name, mf.fileMeta.size, "", buffer),
            type: mf.fileMeta.type
          });
        } else if (mf.url) {
          processedFiles.push({ customFile: mf.url, type: "url" });
        }
      }
    }

    const chatId = String(msg.chatId || "").trim();
    const threadId = msg.threadId ? Number(msg.threadId) : null;
    const text = String(msg.text || "");

    const payload = { chat_id: chatId };
    if (threadId) payload.message_thread_id = threadId;

    try {
      const target = `${chatId}:${threadId || ""}`;
      const dialogs = await telegramMtprotoCall(null, "getDialogs", {}, { userId: msg.userId });
      const verifiedDialogs = await hydrateTelegramTopicAvailability(
        dialogs,
        topicIdsByChatFromTargets([target]),
        { userId: msg.userId }
      );
      assertAccountCanSendToTargets(verifiedDialogs, [target]);
      const send = (method, nextPayload) => sendTelegramPreservingClosedTopic(
        (nextMethod, transportPayload) => telegramMtprotoCall(
          null,
          nextMethod,
          transportPayload,
          { userId: msg.userId }
        ),
        method,
        nextPayload
      );

      let result;
      if (processedFiles.length > 1) {
        payload.media = processedFiles.map((f, i) => ({
          media: f.customFile,
          caption: i === 0 ? text : ""
        }));
        result = await send("sendMediaGroup", payload);
      } else if (processedFiles.length === 1) {
        const f = processedFiles[0];
        payload.caption = text;
        let method = "sendDocument";
        if (f.type?.startsWith("image/")) method = "sendPhoto";
        else if (f.type?.startsWith("video/")) method = "sendVideo";
        else if (f.type === "url") method = "sendPhoto";
        payload[method.slice(4).toLowerCase()] = f.customFile;
        result = await send(method, payload);
      } else {
        payload.text = text;
        result = await send("sendMessage", payload);
      }
      results.push({ id: msg.id, target: `${chatId}:${threadId || ""}`, result });

      // Mark as sent
      const updatedMessages = messages.map(m =>
        m.id === msg.id ? { ...m, status: "sent", sentAt: new Date().toISOString() } : m
      );
      await writeJson(QUEUE_FILE, { messages: updatedMessages });
    } catch (err) {
      console.error(`[composer-cron] Failed to send message ${msg.id}:`, err);
      errors.push({ id: msg.id, error: err.message });

      // Mark as failed
      const updatedMessages = messages.map(m =>
        m.id === msg.id ? { ...m, status: "failed", error: err.message, failedAt: new Date().toISOString() } : m
      );
      await writeJson(QUEUE_FILE, { messages: updatedMessages });
    }

    const remaining = messages.filter(m => m.status === "pending" && m.id !== msg.id).length;
    return NextResponse.json({ ok: true, processed: results.length + errors.length, results, errors, remaining });
  } catch (err) {
    console.error("[composer-cron] Error:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
