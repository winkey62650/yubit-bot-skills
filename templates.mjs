export const communityDisclaimerPartOne = `⚠️ COMMUNITY DISCLAIMER
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

export const communityDisclaimerPartTwo = `6. Affiliate & Promotional Content
Some content may include affiliate links or promotional campaigns. Any rewards or commissions received will not affect the objectivity of shared market discussions.

7. Compliance with Local Laws
It is your responsibility to ensure that trading crypto-assets, or participating in this community complies with the laws and regulations in your country or region.

8. Community Rules
To maintain a high-quality trading community, spam, scams, impersonation, abusive behavior, market manipulation, and misleading information are strictly prohibited. Violations may result in removal from the community.

9. Limitation of Liability
By participating in this community, you acknowledge that all trading decisions are made at your own discretion. The community admins, traders, contributors, affiliates, and community shall not be liable for any losses or damages resulting from the use of information shared within this community.

10. Acknowledgement
By remaining in this community, you confirm that you have read, understood, and agreed to this disclaimer and the community rules.`;

export const antiScamNotice = `🚨 Anti-Scam Notice
1. Never send funds directly to any individual.

2. Community admins will never ask for your password, private key, seed phrase, or verification code.

3. Only trust announcements are published through official YUBIT channels.

4. Beware of fake admins, impersonators, and unsolicited private messages.

5. If you are unsure about any messages or users, please contact a moderator immediately.`;

export const readFirstMessages = [
  { photo: "assets/community-notices/anti-scam-notice.jpg", caption: antiScamNotice },
  { photo: "assets/community-notices/community-disclaimer.jpg", caption: communityDisclaimerPartOne },
  { text: communityDisclaimerPartTwo }
];

export const communityDisclaimer = [communityDisclaimerPartOne, communityDisclaimerPartTwo, antiScamNotice].join("\n\n");

export const defaultTopicTemplate = [
  { id: "1", emoji: "❗", iconCustomEmojiId: "5379748062124056162", name: "READ FIRST - DISLAIMER", attribute: "关闭话题", messages: readFirstMessages },
  { id: "2", emoji: "🖼️", iconCustomEmojiId: "5433614043006903194", name: "Market Events", attribute: "关闭话题" },
  { id: "3", emoji: "💡", iconCustomEmojiId: "5312536423851630001", name: "Market Analysis - Crypto/Stocks/TradFi", attribute: "关闭话题" },
  { id: "4", emoji: "🐲", iconCustomEmojiId: "5309984423003823246", name: "YUBIT Updates", attribute: "交流频道" },
  { id: "6", emoji: "💎", iconCustomEmojiId: "5309958691854754293", name: "Smart Money Tracker", attribute: "交流频道" },
  { id: "7", emoji: "⚡", iconCustomEmojiId: "5312016608254762256", name: "xxx's Trading Zone", attribute: "交流频道" },
  { id: "5", emoji: "💰", iconCustomEmojiId: "5350452584119279096", name: "10k to 100k challenge", attribute: "交流频道" }
];
