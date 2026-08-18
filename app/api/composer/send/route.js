import { NextResponse } from "next/server";
import { telegramMtprotoCall } from "../../../../lib/telegram-mtproto.mjs";
import { readJson, writeJson } from "../../../../lib/json-store.js";
import { randomUUID } from "node:crypto";
import { CustomFile } from "teleproto/client/uploads.js";
import { accountCanSendToTarget, assertAccountCanSendToTargets } from "../../../../lib/telegram-composer-targets.mjs";
import { hydrateTelegramTopicAvailability, topicIdsByChatFromTargets } from "../../../../lib/telegram-topic-availability.mjs";
import { SESSION_COOKIE, verifySessionToken } from "../../../../lib/session.js";
import { canQueueComposerMessage } from "../../../../lib/access-control.mjs";
import { getDistributionRepository } from "../../../../lib/distribution-repository.mjs";
import { expandAutomaticBroadcastTargets } from "../../../../lib/distribution-service.mjs";
import { sendTelegramPreservingClosedTopic } from "../../../../lib/telegram-delivery.mjs";
import { composeManualMessage } from "../../../../lib/manual-cta.mjs";
import { hydrateDestinationCtas } from "../../../../lib/destination-cta.mjs";

function composerTargetEndpoint(value, index) {
  const [chatId, threadId] = String(value).split(":");
  return {
    id: `composer:${index}:${chatId}:${threadId || "channel"}`,
    chatId,
    threadId: threadId ? Number(threadId) : null,
    chatType: threadId ? "supergroup" : "channel",
    enabled: true,
  };
}

function composerTargetValue(target) {
  return `${target.chatId}:${target.chatType === "channel" ? "" : target.threadId}`;
}

export async function POST(req) {
  try {
    const formData = await req.formData();
    const userId = formData.get("userId");
    const text = String(formData.get("text") || "");
    const queue = formData.get("queue") === "true";
    const mediaFiles = formData.getAll("media"); // Array of File or null
    const requestedTargets = formData.getAll("targets"); // array of "chatId:threadId" or "chatId:"

    if (queue) {
      const session = await verifySessionToken(
        req.cookies.get(SESSION_COOKIE)?.value,
        process.env.AUTH_SECRET
      );
      if (!session || !canQueueComposerMessage(session.role)) {
        return NextResponse.json(
          { ok: false, error: "当前账号仅允许立即人工发布" },
          { status: 403 }
        );
      }
    }

    if (!userId || requestedTargets.length === 0) {
      return NextResponse.json({ ok: false, error: "缺少必要参数 (userId, targets)" }, { status: 400 });
    }
    if (!text.trim() && mediaFiles.length === 0) {
      return NextResponse.json({ ok: false, error: "消息内容和附件不能同时为空" }, { status: 400 });
    }

    // A bot-authored source message is not delivered to another bot's webhook, so
    // expand automatic broadcast bindings here and deliver every currently writable target.
    const repository = await getDistributionRepository();
    const expandedTargets = await expandAutomaticBroadcastTargets(
      repository,
      requestedTargets.map(composerTargetEndpoint)
    );
    const hydratedTargets = await hydrateDestinationCtas(repository, expandedTargets);
    const allTargets = [...new Map(hydratedTargets.map((target) => [composerTargetValue(target), target])).entries()];
    const requestedTargetSet = new Set(requestedTargets.map(String));

    // User-selected targets remain strict. Stale automatic destinations are skipped so
    // they cannot block the manual publication that the operator explicitly requested.
    const dialogs = await telegramMtprotoCall(null, "getDialogs", {}, { userId });
    const verifiedDialogs = await hydrateTelegramTopicAvailability(
      dialogs,
      topicIdsByChatFromTargets(allTargets.map(([value]) => value)),
      { userId }
    );
    assertAccountCanSendToTargets(verifiedDialogs, [...requestedTargetSet]);
    const skippedAutomaticTargets = allTargets
      .filter(([value]) => !requestedTargetSet.has(value) && !accountCanSendToTarget(verifiedDialogs, value))
      .map(([target]) => ({ target, error: "自动绑定目标当前不可发送，已跳过" }));
    const targets = allTargets.filter(
      ([value]) => requestedTargetSet.has(value) || accountCanSendToTarget(verifiedDialogs, value)
    );
    const send = (method, payload) => sendTelegramPreservingClosedTopic(
      (nextMethod, nextPayload) => telegramMtprotoCall(
        null,
        nextMethod,
        nextPayload,
        { userId }
      ),
      method,
      payload
    );

    const processedFiles = [];
    
    for (const media of mediaFiles) {
      if (media && typeof media !== "string") {
        const buffer = Buffer.from(await media.arrayBuffer());
        if (queue) {
          processedFiles.push({
            base64Data: buffer.toString('base64'),
            fileMeta: { name: media.name, size: media.size, type: media.type }
          });
        } else {
          processedFiles.push({
            customFile: new CustomFile(media.name, media.size, "", buffer),
            type: media.type
          });
        }
      } else if (typeof media === "string" && media.trim()) {
        if (queue) {
           processedFiles.push({ url: media.trim() });
        } else {
           processedFiles.push({ customFile: media.trim(), type: "url" });
        }
      }
    }

    if (queue) {
      const queueFile = "composer-queue.json";
      const data = await readJson(queueFile, { messages: [] });
      for (const [target, targetConfig] of targets) {
        const [chatId, threadId] = target.split(":");
        const composedText = composeManualMessage(text, targetConfig, { limit: mediaFiles.length > 0 ? 1024 : 4096 });
        data.messages.push({
          id: randomUUID(),
          userId,
          chatId,
          threadId: threadId ? Number(threadId) : null,
          text: composedText,
          mediaFiles: processedFiles,
          createdAt: new Date().toISOString(),
          status: "pending"
        });
      }
      await writeJson(queueFile, data);
      return NextResponse.json({
        ok: true,
        queued: true,
        results: targets.map(([value]) => value),
        skippedAutomaticTargets,
        warning: skippedAutomaticTargets.length
          ? `已加入队列；${skippedAutomaticTargets.length} 个不可用的自动绑定目标已跳过。`
          : ""
      });
    }

    // Send immediately
    const results = [];
    const errors = [];

    for (const [target, targetConfig] of targets) {
      const [chatId, threadId] = target.split(":");
      const composedText = composeManualMessage(text, targetConfig, { limit: mediaFiles.length > 0 ? 1024 : 4096 });
      const payload = { chat_id: chatId, parse_mode: "Markdown" };
      if (threadId) {
        payload.message_thread_id = Number(threadId);
      }

      try {
        let result;
        if (processedFiles.length > 1) {
           // Use sendMediaGroup
           payload.media = processedFiles.map((fileObj, index) => ({
             media: fileObj.customFile,
             caption: index === 0 ? composedText : "", // Attach caption to first file
             parse_mode: "Markdown"
           }));
           result = await send("sendMediaGroup", payload);
        } else if (processedFiles.length === 1) {
           // Single file
           const fileObj = processedFiles[0];
           payload.caption = composedText;
           
           let method = "sendDocument";
           if (fileObj.type) {
             if (fileObj.type.startsWith("image/")) method = "sendPhoto";
             else if (fileObj.type.startsWith("video/")) method = "sendVideo";
           } else if (typeof fileObj.customFile === "string") {
             method = "sendPhoto"; // Default url to photo
           }
           
           payload[method.slice(4).toLowerCase()] = fileObj.customFile;
           result = await send(method, payload);
        } else {
           // Text only
           payload.text = composedText;
           result = await send("sendMessage", payload);
        }
        results.push({ target, result });
      } catch (err) {
        console.error(`Error sending to ${target}:`, err);
        errors.push({ target, error: err.message || String(err) });
      }
    }

    const noTargetsDelivered = results.length === 0;
    const requestedErrors = errors.filter(({ target }) => requestedTargetSet.has(target));
    if ((errors.length > 0 && requestedErrors.length > 0) || results.length === 0) {
      const summary = noTargetsDelivered
        ? `Telegram 未送达任何目标（失败 ${errors.length} 个）`
        : `部分目标发送失败（成功 ${results.length} 个，失败 ${errors.length} 个）`;
      const reason = errors[0]?.error ? `：${errors[0].error}` : "";
      return NextResponse.json({
        ok: false,
        partial: !noTargetsDelivered,
        error: `${summary}${reason}`,
        results,
        errors
      }, { status: noTargetsDelivered ? 502 : 207 });
    }

    const automaticWarnings = [...skippedAutomaticTargets, ...errors];
    return NextResponse.json({
      ok: true,
      results,
      errors: [],
      skippedAutomaticTargets: automaticWarnings,
      warning: automaticWarnings.length
        ? `发布成功；${automaticWarnings.length} 个不可用的自动绑定目标已跳过。`
        : ""
    });
  } catch (err) {
    console.error("Composer send error:", err);
    const status = err?.code === "TELEGRAM_ACCOUNT_TARGET_FORBIDDEN"
      ? 403
      : err?.code === "TELEGRAM_TOPIC_NOT_WRITABLE" || err?.code === "TELEGRAM_FORUM_TOPIC_REQUIRED"
        ? 409
        : err?.code === "TELEGRAM_TOPIC_STATUS_UNAVAILABLE"
          ? 503
          : 500;
    return NextResponse.json({ ok: false, error: err.message || String(err) }, { status });
  }
}
