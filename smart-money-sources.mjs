export const smartMoneySources = [
  {
    name: "Binance Futures public market data",
    kind: "API",
    access: "No key",
    status: "Enabled",
    env: "",
    coverage: "BTC/ETH/SOL order-book walls and recent liquidation orders on Binance USD-M futures.",
    endpoint: "https://fapi.binance.com",
    note: "Good free baseline for large orders and recent forced orders, but it does not cover all exchanges."
  },
  {
    name: "Whale Alert Alerts API",
    kind: "WebSocket API",
    access: "7-day trial, then paid API key",
    status: "Key required",
    env: "WHALE_ALERT_API_KEY",
    coverage: "Large BTC/ETH/SOL/USDT transfers with owner/entity mapping for from/to addresses.",
    endpoint: "wss://leviathan.whale-alert.io/ws?api_key=$WHALE_ALERT_API_KEY",
    note: "Best fit for real-time whale transfer alerts into Telegram."
  },
  {
    name: "Arkham API",
    kind: "API",
    access: "Paid/enterprise API key",
    status: "Key required",
    env: "ARKHAM_API_KEY",
    coverage: "Labeled entities, exchange wallets, ETFs, companies, funds, and large labeled flows.",
    endpoint: "https://arkm.com/api",
    note: "Best fit for known whale/institution labels and treasury-company wallet tracking."
  },
  {
    name: "Nansen API",
    kind: "API",
    access: "Paid API key or x402",
    status: "Key required",
    env: "NANSEN_API_KEY",
    coverage: "Smart Money, fund labels, wallet profiler, token flows, portfolio and PnL-style wallet analysis.",
    endpoint: "https://api.nansen.ai",
    note: "Best fit for high-win-rate wallets, Smart Money labels, adds/reduces, and realized/unrealized PnL signals."
  },
  {
    name: "Glassnode Institutions API",
    kind: "API",
    access: "Paid API add-on",
    status: "Key optional adapter",
    env: "GLASSNODE_API_KEY",
    coverage: "US spot BTC/ETH ETF net flows, balances, and institution-level aggregate metrics.",
    endpoint: "https://api.glassnode.com/v1/metrics/institutions/us_spot_etf_flows_net",
    note: "Good fit for BTC ETF and ETH ETF net inflow/outflow snapshots."
  },
  {
    name: "CryptoQuant API",
    kind: "API",
    access: "Paid/API key required",
    status: "Key required",
    env: "CRYPTOQUANT_API_KEY",
    coverage: "Exchange inflow, outflow, netflow, reserves, miner flows, and stablecoin exchange flows.",
    endpoint: "https://api.cryptoquant.com",
    note: "Best fit for BTC/ETH/USDT exchange net inflow/outflow by asset and exchange."
  },
  {
    name: "CoinGlass API",
    kind: "API",
    access: "Paid API key",
    status: "Key optional adapter",
    env: "COINGLASS_API_KEY",
    coverage: "Liquidation heatmaps, liquidation history, open interest, funding, ETF lists and ETF asset history.",
    endpoint: "https://open-api-v4.coinglass.com",
    note: "Best fit for liquidation heatmap / large liquidation point monitoring."
  },
  {
    name: "SoSoValue API",
    kind: "API",
    access: "Free/demo key available",
    status: "Key required",
    env: "SOSOVALUE_API_KEY",
    coverage: "BTC and ETH spot ETF flows, ETF market data, crypto AI feeds.",
    endpoint: "https://sosovalue.com/developer",
    note: "Good fit for ETF flow cards if you prefer SoSoValue's public dashboard numbers."
  }
];

export const recommendedSmartMoneySources = smartMoneySources.filter((source) =>
  [
    "Binance Futures public market data",
    "Whale Alert Alerts API",
    "Glassnode Institutions API",
    "CryptoQuant API",
    "CoinGlass API",
    "Nansen API"
  ].includes(source.name)
);
