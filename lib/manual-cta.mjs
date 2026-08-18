export function isAllowedManualCtaUrl(value) {
  const url = String(value || "").trim();
  if (!url) return true;
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function manualCtaContent(cta = {}) {
  if (cta.ctaEnabled === false) return "";
  if (Object.prototype.hasOwnProperty.call(cta, "ctaContent") || Object.prototype.hasOwnProperty.call(cta, "content")) {
    return String(cta.ctaContent ?? cta.content ?? "").trim();
  }
  const ctaText = String(cta.ctaText || "").trim();
  const ctaUrl = String(cta.ctaUrl || "").trim();
  if (!isAllowedManualCtaUrl(ctaUrl)) {
    throw new Error("CTA 链接必须使用 http or https。");
  }
  return [ctaText, ctaUrl].filter(Boolean).join("\n");
}

function truncateMessageBody(value, limit) {
  const text = String(value || "").trim();
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  if (limit === 1) return "…";
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function composeManualMessage(body, cta = {}, options = {}) {
  const text = String(body || "").trim();
  const ctaBlock = manualCtaContent(cta);
  const limit = Number(options.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return text && ctaBlock ? `${text}\n\n${ctaBlock}` : text || ctaBlock;
  }
  if (ctaBlock.length > limit) {
    throw new Error(`CTA 内容不能超过 ${limit} 个字符。`);
  }
  if (!ctaBlock) return truncateMessageBody(text, limit);

  const bodyLimit = limit - ctaBlock.length - 2;
  const truncatedBody = bodyLimit > 0 ? truncateMessageBody(text, bodyLimit) : "";
  return truncatedBody ? `${truncatedBody}\n\n${ctaBlock}` : ctaBlock;
}
