import { NextResponse } from "next/server";
import { telegramMtprotoCall } from "../../../../lib/telegram-mtproto.mjs";
import { readJson, writeJson } from "../../../../lib/json-store.js";
import { randomUUID } from "node:crypto";
import { CustomFile } from "teleproto/client/uploads.js";

export async function POST(req) {
  try {
    const formData = await req.formData();
    const userId = formData.get("userId");
    const text = formData.get("text") || "";
    const queue = formData.get("queue") === "true";
    const mediaFiles = formData.getAll("media"); // Array of File or null
    const targets = formData.getAll("targets"); // array of "chatId:threadId" or "chatId:"

    if (!userId || targets.length === 0) {
      return NextResponse.json({ ok: false, error: "缺少必要参数 (userId, targets)" }, { status: 400 });
    }
    if (!text && mediaFiles.length === 0) {
      return NextResponse.json({ ok: false, error: "消息内容和附件不能同时为空" }, { status: 400 });
    }

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
      for (const target of targets) {
        const [chatId, threadId] = target.split(":");
        data.messages.push({
          id: randomUUID(),
          userId,
          chatId,
          threadId: threadId ? Number(threadId) : null,
          text,
          mediaFiles: processedFiles,
          createdAt: new Date().toISOString(),
          status: "pending"
        });
      }
      await writeJson(queueFile, data);
      return NextResponse.json({ ok: true, queued: true, results: targets });
    }

    // Send immediately
    const results = [];
    const errors = [];

    for (const target of targets) {
      const [chatId, threadId] = target.split(":");
      const payload = { chat_id: chatId };
      if (threadId) {
        payload.message_thread_id = Number(threadId);
      }

      try {
        let result;
        if (processedFiles.length > 1) {
           // Use sendMediaGroup
           payload.media = processedFiles.map((fileObj, index) => ({
             media: fileObj.customFile,
             caption: index === 0 ? text : "" // Attach caption to first file
           }));
           result = await telegramMtprotoCall(null, "sendMediaGroup", payload, { userId });
        } else if (processedFiles.length === 1) {
           // Single file
           const fileObj = processedFiles[0];
           payload.caption = text || "";
           
           let method = "sendDocument";
           if (fileObj.type) {
             if (fileObj.type.startsWith("image/")) method = "sendPhoto";
             else if (fileObj.type.startsWith("video/")) method = "sendVideo";
           } else if (typeof fileObj.customFile === "string") {
             method = "sendPhoto"; // Default url to photo
           }
           
           payload[method.slice(4).toLowerCase()] = fileObj.customFile;
           result = await telegramMtprotoCall(null, method, payload, { userId });
        } else {
           // Text only
           payload.text = text;
           result = await telegramMtprotoCall(null, "sendMessage", payload, { userId });
        }
        results.push({ target, result });
      } catch (err) {
        console.error(`Error sending to ${target}:`, err);
        errors.push({ target, error: err.message || String(err) });
      }
    }

    const noTargetsDelivered = results.length === 0;
    if (errors.length > 0) {
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

    return NextResponse.json({ ok: true, results, errors: [] });
  } catch (err) {
    console.error("Composer send error:", err);
    return NextResponse.json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
}
