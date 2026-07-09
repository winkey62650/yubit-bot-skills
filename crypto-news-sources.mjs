export const cryptoNewsSources = [
  {
    name: "Google News RSS",
    kind: "RSS",
    access: "无需密钥",
    status: "Enabled",
    endpoint: "https://news.google.com/rss/search?q=cryptocurrency+OR+bitcoin+OR+ethereum&hl=en-US&gl=US&ceid=US:en",
    coverage: "Broad crypto, ETFs, exchanges, macro headlines",
    note: "默认备用新闻源"
  },
  {
    name: "Cointelegraph RSS",
    kind: "RSS",
    access: "无需密钥",
    status: "Ready",
    endpoint: "https://cointelegraph.com/rss",
    coverage: "Crypto-native breaking news and market stories",
    note: "Good high-volume source"
  },
  {
    name: "CoinDesk RSS",
    kind: "RSS",
    access: "无需密钥",
    status: "Ready",
    endpoint: "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml",
    coverage: "Institutional crypto news, policy, markets",
    note: "Use RSS for no-key ingestion"
  },
  {
    name: "CryptoSlate RSS",
    kind: "RSS",
    access: "无需密钥",
    status: "Ready",
    endpoint: "https://cryptoslate.com/feed/",
    coverage: "Market, project, company and regulation news",
    note: "Good for source diversity"
  },
  {
    name: "Decrypt RSS",
    kind: "RSS",
    access: "无需密钥",
    status: "Ready",
    endpoint: "https://decrypt.co/feed",
    coverage: "Web3, culture, markets and regulation",
    note: "Useful for user-friendly summaries"
  },
  {
    name: "Bitcoin.com News RSS",
    kind: "RSS",
    access: "无需密钥",
    status: "Ready",
    endpoint: "https://news.bitcoin.com/feed/",
    coverage: "Bitcoin, exchanges, regulation, market news",
    note: "High-volume crypto news feed"
  },
  {
    name: "NewsBTC RSS",
    kind: "RSS",
    access: "无需密钥",
    status: "Ready",
    endpoint: "https://www.newsbtc.com/feed/",
    coverage: "Bitcoin, Ethereum and price-analysis headlines",
    note: "Useful for trading context"
  },
  {
    name: "The Defiant RSS",
    kind: "RSS",
    access: "无需密钥",
    status: "Ready",
    endpoint: "https://thedefiant.io/feed",
    coverage: "DeFi, protocols, on-chain ecosystem",
    note: "Best for DeFi lane"
  },
  {
    name: "Blockworks RSS",
    kind: "RSS",
    access: "无需密钥",
    status: "Ready",
    endpoint: "https://blockworks.co/feed",
    coverage: "Crypto markets, policy, institutions",
    note: "Good institutional tone"
  },
  {
    name: "U.Today RSS",
    kind: "RSS",
    access: "无需密钥",
    status: "Ready",
    endpoint: "https://u.today/rss",
    coverage: "Crypto market news and token updates",
    note: "Good for altcoin coverage"
  },
  {
    name: "Bitcoin Magazine RSS",
    kind: "RSS",
    access: "无需密钥",
    status: "Ready",
    endpoint: "https://bitcoinmagazine.com/.rss/full/",
    coverage: "Bitcoin-native news and analysis",
    note: "Use for BTC-only mode"
  },
  {
    name: "CoinMarketCap Headlines",
    kind: "RSS",
    access: "无需密钥",
    status: "Ready",
    endpoint: "https://coinmarketcap.com/headlines/rss/",
    coverage: "Aggregated crypto headlines",
    note: "Good backup aggregator"
  },
  {
    name: "CryptoPanic API",
    kind: "API",
    access: "需要密钥",
    status: "Key required",
    endpoint: "https://cryptopanic.com/api/v2/posts/?auth_token=$CRYPTOPANIC_API_KEY",
    coverage: "Aggregated crypto news, sentiment and voting",
    note: "Free developer plan was discontinued in 2026; treat as paid/keyed"
  },
  {
    name: "CoinDesk Data API News",
    kind: "API",
    access: "需要密钥",
    status: "Key required",
    endpoint: "https://data-api.coindesk.com/news/v1/article/list",
    coverage: "Structured crypto news and active source list",
    note: "适合保留来源信息和稳定字段"
  },
  {
    name: "CryptoNews API",
    kind: "API",
    access: "需要密钥",
    status: "Key required",
    endpoint: "https://cryptonews-api.com/api/v1?tickers=BTC,ETH&items=10&token=$CRYPTONEWS_API_KEY",
    coverage: "Ticker-tagged news, videos, sentiment, whale transactions",
    note: "Good for sentiment and ticker filters"
  },
  {
    name: "NewsData.io Crypto API",
    kind: "API",
    access: "需要密钥",
    status: "Key required",
    endpoint: "https://newsdata.io/api/1/news?apikey=$NEWSDATA_API_KEY&q=cryptocurrency",
    coverage: "Global multi-language crypto and blockchain news",
    note: "Good for regional and language expansion"
  },
  {
    name: "Benzinga Crypto News API",
    kind: "API",
    access: "需要密钥",
    status: "Key required",
    endpoint: "https://api.benzinga.com/api/v2/news?channels=cryptocurrency&token=$BENZINGA_API_KEY",
    coverage: "Real-time actionable crypto market news",
    note: "REST, WebSocket and RSS options"
  },
  {
    name: "ChainGPT AI Crypto News",
    kind: "API/RSS",
    access: "部分需要密钥",
    status: "Ready",
    endpoint: "ChainGPT AI News API / public RSS feeds",
    coverage: "AI-deduplicated crypto news summaries",
    note: "Good for concise Telegram-friendly summaries"
  },
  {
    name: "APITube Crypto News API",
    kind: "API",
    access: "需要密钥",
    status: "Key required",
    endpoint: "https://api.apitube.io/v1/news/everything?category=crypto",
    coverage: "Crypto, blockchain, DeFi, NFT and regulation coverage",
    note: "Alternative commercial aggregator"
  },
  {
    name: "cryptocurrency.cv",
    kind: "API/RSS",
    access: "无需密钥",
    status: "Ready",
    endpoint: "https://cryptocurrency.cv/api/news",
    coverage: "Open-source real-time crypto news aggregator",
    note: "No-key JSON/RSS option; verify uptime before production"
  }
];

export const recommendedCryptoNewsSources = cryptoNewsSources.filter((source) =>
  ["Google News RSS", "Cointelegraph RSS", "CoinDesk RSS", "CryptoSlate RSS", "Decrypt RSS", "CryptoPanic API", "CryptoNews API", "ChainGPT AI Crypto News"].includes(source.name)
);
