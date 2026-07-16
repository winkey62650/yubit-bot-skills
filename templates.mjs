export const communityDisclaimer = `⚠️ COMMUNITY DISCLAIMER
Please read before participating in this community.
1. Educational Purpose Only
All market analysis, trade setups, charts, and discussions shared in this community are provided for educational and informational purposes only. Nothing should be considered financial or investment advice.
2. Trade at Your Own Risk
Trading cryptocurrencies, stocks, futures, and other financial products involves significant risk. You are solely responsible for your own trading decisions and any resulting profits or losses.
3. No Guaranteed Returns
Past performance, screenshots, PnL, or trading results do not guarantee future performance. Markets are volatile, and losses may occur.
4. Community Discussions Only
Trade ideas shared by moderators, traders, KOLs, or community members represent personal opinions only and should not be interpreted as recommendations to buy or sell any asset.
5. No Fund Management
We never request, hold, or manage user funds. This community does not provide portfolio management, copy trading, or investment advisory services.
6. Affiliate & Promotional Content
Some content may include affiliate links or promotional campaigns. Any rewards or commissions received will not affect the objectivity of shared market discussions.
7. Compliance with Local Laws
It is your responsibility to ensure that using YUBIT, trading crypto-assets, or participating in this community complies with the laws and regulations in your country or region.
8. Community Rules
To maintain a high-quality trading community, spam, scams, impersonation, abusive behavior, market manipulation, and misleading information are strictly prohibited. Violations may result in removal from the community.
9. Limitation of Liability
By participating in this community, you acknowledge that all trading decisions are made at your own discretion. The community admins, traders, contributors, affiliates, and YUBIT shall not be liable for any losses or damages resulting from the use of information shared within this community.
10. Acknowledgement
By remaining in this community, you confirm that you have read, understood, and agreed to this disclaimer and the community rules.

🚨 Anti-Scam Notice
Never send funds directly to any individual.
Community admins will never ask for your password, private key, seed phrase, or verification code.
Only trust announcements published through official YUBIT channels.
Beware of fake admins, impersonators, and unsolicited private messages.
If you are unsure about any messages or users, please contact a moderator immediately.`;

export const readFirstContentVersion = "demo-read-first-2026-07-14-v1";

const readFirstDisclaimerCaption = `⚠️ COMMUNITY DISCLAIMER
Please read before participating in this community.

1. Educational Purpose Only
All market analysis, trade setups, charts, and discussions shared in this community are provided for educational and informational purposes only. Nothing should be considered financial or investment advice.

2. Trade at Your Own Risk
Trading cryptocurrencies, stocks, futures, and other financial products involves significant risk. You are solely responsible for your own trading decisions and any resulting profits or losses.

3. No Guaranteed Returns
Past performance, screenshots, PnL, or trading results do not guarantee future performance. Markets are volatile, and losses may occur.

4. Community Discussions Only
Trade ideas shared by moderators, traders, KOLs, or community members represent personal opinions only and should not be interpreted as recommendations to buy or sell any asset

5. No Fund Management
We never request, hold, or manage user funds. This community does not provide portfolio management`;

const readFirstDisclaimerRemainder = `6. Affiliate & Promotional Content
Some content may include affiliate links or promotional campaigns. Any rewards or commissions received will not affect the objectivity of shared market discussions.

7. Compliance with Local Laws
It is your responsibility to ensure that  trading crypto-assets, or participating in this community complies with the laws and regulations in your country or region.

8. Community Rules
To maintain a high-quality trading community, spam, scams, impersonation, abusive behavior, market manipulation, and misleading information are strictly prohibited. Violations may result in removal from the community.

9. Limitation of Liability
By participating in this community, you acknowledge that all trading decisions are made at your own discretion. The community admins, traders, contributors, affiliates, and community shall not be liable for any losses or damages resulting from the use of information shared within this community.

10. Acknowledgement
By remaining in this community, you confirm that you have read, understood, and agreed to this disclaimer and the community rules.`;

const readFirstAntiScamCaption = `🚨 Anti-Scam Notice
1. Never send funds directly to any individual.

2. Community admins will never ask for your password, private key, seed phrase, or verification code.

3. Only trust announcements are published through official YUBIT channels.

4. Beware of fake admins, impersonators, and unsolicited private messages.

5. If you are unsure about any messages or users, please contact a moderator immediately.`;

// Telegram file IDs belong to the admin bot and preserve the exact images used
// by the approved Demo snapshot without recompressing or regenerating them.
export const readFirstPinnedMessages = Object.freeze([
  Object.freeze({
    type: "photo",
    photo: "AgACAgEAAyEFAAMBBPXYWgADGmpWD1xXjHzHEOhQD71EYPT6AAFopAACWgxrG6zEsUbnorjMxlq0TQEAAwIAA3kAAz0E",
    caption: readFirstDisclaimerCaption,
    pin: true
  }),
  Object.freeze({
    type: "text",
    text: readFirstDisclaimerRemainder,
    pin: true
  }),
  Object.freeze({
    type: "photo",
    photo: "AgACAgEAAyEFAAMBBPXYWgADHmpWD7hnErfKgxQG_v4PtRFVkUGhAAJdDGsbrMSxRs0o_-siZRRHAQADAgADeQADPQQ",
    caption: readFirstAntiScamCaption,
    captionEntities: Object.freeze([
      Object.freeze({ offset: 0, length: 19, type: "bold" }),
      Object.freeze({ offset: 94, length: 5, type: "bold" })
    ]),
    pin: true
  })
]);

export const defaultTopicTemplate = [
  {
    id: "1",
    emoji: "❗️",
    name: "READ FIRST - DISCLAIMER",
    attribute: "关闭话题",
    announcement: communityDisclaimer,
    contentVersion: readFirstContentVersion,
    messages: readFirstPinnedMessages
  },
  { id: "5", emoji: "💰", name: "Community Signal", attribute: "交流频道" },
  { id: "4", emoji: "💡", name: "Market Analysis - Crypto/Stocks/TradFi", attribute: "关闭话题" },
  { id: "3", emoji: "📰", name: "Market Events", attribute: "关闭话题" },
  { id: "6", emoji: "💎", name: "Smart Money Tracker", attribute: "关闭话题" },
  { id: "7", emoji: "🎉", name: "YUBIT Updates", attribute: "频道禁言" },
  { id: "2", emoji: "⚡️", name: "CryptoGuy Trading Zone", attribute: "交流频道" }
];

const legacyDefaultIcons = Object.freeze({
  // Previous releases used a different semantic order and icons.  Keep all
  // known legacy values so existing saved templates are migrated idempotently
  // while custom icons remain untouched.
  "1": ["⚠️"],
  "2": ["📅", "📰"],
  "3": ["📊"],
  "4": ["📢", "📊"],
  "5": ["🏆"],
  "6": ["🐳"],
  "7": ["🎯", "📢"]
});

export function migrateTopicTemplate(topic) {
  const sequence = String(topic?.id || "").trim();
  const currentIcon = String(topic?.emoji || "").trim();
  const replacement = defaultTopicTemplate.find((item) => item.id === sequence)?.emoji;
  const legacyIcons = legacyDefaultIcons[sequence] ?? [];
  if (!replacement || !legacyIcons.includes(currentIcon)) return { ...topic };
  return { ...topic, emoji: replacement };
}

export function topicNameWithSequence(topic) {
  const name = String(topic?.name || "").replace(/^[^\p{Letter}\p{Number}]+/u, "").trim();
  const sequence = String(topic?.id || "").trim();
  if (!sequence) return name;
  const nameWithoutSequence = name.replace(/^\d+\.\s*/, "").trim();
  return `${sequence}. ${nameWithoutSequence}`;
}

export function topicDisplayName(topic) {
  return topicNameWithSequence(topic);
}
