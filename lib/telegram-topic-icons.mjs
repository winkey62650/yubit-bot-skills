export const defaultForumTopicIconIds = Object.freeze({
  "❗": "5379748062124056162",
  "📰": "5434144690511290129",
  "💡": "5312536423851630001",
  "🎉": "5310228579009699834",
  "💰": "5350452584119279096",
  "💎": "5309958691854754293",
  "⚡": "5312016608254762256"
});

function normalizeEmoji(value) {
  return String(value || "").replaceAll("\uFE0F", "").trim();
}

export function resolveForumTopicIconId(topic, availableStickers = []) {
  const explicit = String(topic?.iconCustomEmojiId || "").trim();
  if (explicit) return explicit;

  const emoji = normalizeEmoji(topic?.emoji);
  if (!emoji) return "";

  const liveSticker = availableStickers.find((sticker) => normalizeEmoji(sticker?.emoji) === emoji);
  return String(liveSticker?.custom_emoji_id || defaultForumTopicIconIds[emoji] || "");
}
