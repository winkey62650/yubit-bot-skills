const VALID_RANGES = new Set(["7d", "30d", "90d"]);

export function normalizeSiteAnalyticsQuery(input = {}) {
  const range = VALID_RANGES.has(String(input.range || "")) ? String(input.range) : "30d";
  const requestedSite = String(input.site || "all").trim();
  const site = /^[a-zA-Z0-9_-]{1,80}$/.test(requestedSite) ? requestedSite : "all";
  return { range, site };
}

export function buildSiteAnalyticsUrl(input = {}, env = process.env) {
  const { range, site } = normalizeSiteAnalyticsQuery(input);
  const baseUrl = String(env.SITE_ANALYTICS_INTERNAL_URL || "http://127.0.0.1:4180").replace(/\/+$/, "");
  const query = new URLSearchParams({ range, site });
  return `${baseUrl}/api/analytics?${query}`;
}

export async function fetchSiteAnalytics(input = {}, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(buildSiteAnalyticsUrl(input, options.env), {
    cache: "no-store",
    signal: options.signal
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok || !payload?.data?.kpis) {
    const message = payload?.error?.message || payload?.error || `站点数据服务返回 ${response.status}`;
    const error = new Error(message);
    error.statusCode = response.ok ? 502 : response.status;
    throw error;
  }
  return payload.data;
}
