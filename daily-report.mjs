import process from "node:process";

const telegramBase = "https://api.telegram.org/bot";
const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TRADER1_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const threadId = Number(process.env.TELEGRAM_THREAD_ID || 0);
const shouldSend = process.env.SEND_TELEGRAM === "true";

export const defaultDailyReport = `Morning Market Highlights (Jul 7)

1. The Nasdaq rose more than 1%, reversing a two-day losing streak, while the Dow hit another record high and the chip index gained more than 2%. AMD closed up 6.6%. Bitcoin briefly rebounded more than 4% after Trump described himself as a crypto "diehard." Crude oil pulled back, with WTI falling to its lowest level since before the Iran-US conflict began.
2. Veteran memecoin Bonk said on its official X account that the BonkDAO treasury had been attacked through a malicious governance proposal, resulting in the theft of about $20 million worth of BONK tokens.
3. Global semiconductor giant Samsung Electronics reported extremely strong preliminary Q2 earnings. Operating profit rose more than 1,800% year over year, with quarterly profit exceeding the combined total of the previous three years. The company plans to release its full earnings report on July 30, when more operating details will be disclosed.
4. ANSEM's market cap reached a new all-time high, peaking at $449 million. The latest rally may have been driven by Ansem himself (X: blknoiz06) announcing that a new round of airdrops had been completed, with cumulative distributions reaching about $7 million.
5. CZ said on social media: "I neither hold nor know about the newly issued Meme coins CZ, TCC, and AB on BNB Chain. I am simply interacting with active and energetic users in the community. May the best Meme win."
6. Trump, often dubbed the "White House stock picker," mentioned Dell and Micron Technology again. This was his third recent public mention, and he also urged everyone to buy a Dell computer. When asked whether a "Trump account" could include Bitcoin, he said: "It could happen."
7. Passive rebalancing by Nasdaq 100 index funds added SpaceX exposure, triggering about $4.3 billion in passive buying. Tens of millions of US investors will indirectly hold SpaceX through 401(k), IRA, and similar accounts. The market believes the real test will come after the August 6 earnings report and the expiration of internal share lockups.
8. Serenity posted that it remains bullish long term on Swedish photonics company Sivers Semiconductors (SIVE), arguing that it could become the "next Lumentum (LITE)."
9. Solana activity was boosted by ANSEM and related names, with active addresses over the past seven days rising to about 31.385 million, up 38% week over week, and seven-day trading volume reaching $13.63 billion. BNB Chain was also lifted by trading in TCC, CZ, and other memecoins, with 24-hour trading volume rising from $240 million to $350 million, an increase of about 45%.
10. Lighter has rebounded more than 2.5x from its recent low. Market discussion has been fueled by positive catalysts including tokenomics changes toward full buyback and permanent burn, integration with Robinhood Wallet, an $11 million LIT rewards pool, and Vitalik publicly naming Lighter as one of the Ethereum ecosystem projects worth watching.
11. Bitcoin treasury company Strategy disclosed in filings that it began gradually selling Bitcoin last week to build more cash. The company sold 3,588 BTC at an average price of $59,000 last week and still holds 843,000 BTC on its balance sheet.`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const title = process.env.DAILY_REPORT_TITLE || "";
  const body = process.env.DAILY_REPORT_BODY || defaultDailyReport;
  const message = formatDailyReport(title, body);

  console.log(message);

  if (shouldSend) {
    if (!token || !chatId) {
      throw new Error("TELEGRAM_BOT_TOKEN/TRADER1_BOT_TOKEN and TELEGRAM_CHAT_ID are required when SEND_TELEGRAM=true");
    }
    await postTelegram(message);
  }
}

export function formatDailyReport(title, body) {
  const text = String(body || defaultDailyReport).trim();
  const { heading, items } = parseDailyReport(text);
  const finalTitle = title || heading || "Morning Market Highlights";
  const lines = [
    `<b>${escapeHtml(finalTitle)}</b>`,
    "<i>Key overnight moves across crypto, equities and macro.</i>",
    ""
  ];

  if (!items.length) {
    lines.push(escapeHtml(text));
    return trimTelegram(lines.join("\n"));
  }

  items.forEach((item, index) => {
    lines.push(`<b>${index + 1}. ${escapeHtml(classifyDailyItem(item))}</b>`);
    lines.push(escapeHtml(item));
    if (index !== items.length - 1) lines.push("");
  });

  lines.push("", "<i>Market update only. Not investment advice.</i>");
  return trimTelegram(lines.join("\n"));
}

function parseDailyReport(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines[0] && !/^\d+\./.test(lines[0]) ? lines[0] : "";
  const body = heading ? lines.slice(1).join("\n") : lines.join("\n");
  const matches = [...body.matchAll(/(?:^|\n)(\d+)\.\s+([\s\S]*?)(?=\n\d+\.\s+|$)/g)];
  return {
    heading,
    items: matches.map((match) => match[2].replace(/\s+/g, " ").trim()).filter(Boolean)
  };
}

function classifyDailyItem(item) {
  const text = String(item || "").toLowerCase();
  const rules = [
    [/nasdaq.*crude|dow.*crude|wti/, "Market Wrap"],
    [/spacex|nasdaq 100|index funds|401\(k\)|ira/, "Passive Flows"],
    [/strategy|bitcoin treasury|btc|balance sheet/, "Bitcoin Treasuries"],
    [/\bcz\b|meme coin/, "BNB Chain"],
    [/solana|active addresses|bnb chain|trading volume/, "On-chain Activity"],
    [/bonk|bonkdao|stolen|attack|malicious/, "Security & Governance"],
    [/samsung|semiconductor|earnings|operating profit/, "Semiconductors"],
    [/ansem|airdrop|market cap/, "Token Momentum"],
    [/trump|dell|micron|bitcoin/, "US Politics & Stocks"],
    [/sivers|lumentum|photonics/, "Equity Watch"],
    [/lighter|robinhood|vitalik|rewards pool/, "Ethereum Ecosystem"],
    [/nasdaq|dow|amd|bitcoin|crude|wti|oil/, "Market Wrap"]
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || "Market Highlight";
}

async function postTelegram(text) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  if (threadId) payload.message_thread_id = threadId;
  const response = await fetch(`${telegramBase}${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.description || "Telegram sendMessage failed");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function trimTelegram(text) {
  return text.length > 3900 ? `${text.slice(0, 3850)}\n\n<i>Output trimmed for Telegram.</i>` : text;
}
