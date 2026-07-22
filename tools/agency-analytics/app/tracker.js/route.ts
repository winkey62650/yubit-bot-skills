export const dynamic = "force-dynamic";

const tracker = String.raw`(() => {
  "use strict";
  const script = document.currentScript;
  if (!script) return;
  const source = new URL(script.src);
  const siteId = source.searchParams.get("site");
  const key = source.searchParams.get("key");
  if (!siteId || !key) return;

  const endpoint = source.origin + "/api/events";
  const uidKey = "aa_uid";
  const sessionKey = "aa_session";
  const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  let anonymousId = localStorage.getItem(uidKey);
  if (!anonymousId) { anonymousId = randomId(); localStorage.setItem(uidKey, anonymousId); }
  let sessionId = sessionStorage.getItem(sessionKey);
  if (!sessionId) { sessionId = randomId(); sessionStorage.setItem(sessionKey, sessionId); }
  let lastActivity = Date.now();
  let lastPage = location.pathname + location.search + location.hash;

  const basePayload = () => ({
    siteId, key, anonymousId, sessionId,
    path: location.pathname + location.search + location.hash,
    occurredAt: new Date().toISOString(),
    referrer: document.referrer || undefined,
  });

  const emit = (eventType, detail = {}, useBeacon = false) => {
    const body = JSON.stringify({ ...basePayload(), eventType, ...detail });
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
      return;
    }
    fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true })
      .catch(() => window.dispatchEvent(new CustomEvent("agency-analytics:error")));
  };

  const pageView = () => emit("page_view");
  pageView();

  ["click", "keydown", "mousemove", "scroll", "touchstart"].forEach((name) => {
    addEventListener(name, () => { lastActivity = Date.now(); }, { passive: true });
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest("[data-track],[data-track-event],a[href^='https://t.me/'],a[href^='tg:']")
      : null;
    if (!target) return;
    const label = target.getAttribute("data-track") || target.id || target.getAttribute("aria-label") || target.textContent || "unnamed-cta";
    const eventType = target.getAttribute("data-track-event") === "video_play" ? "video_play" : "cta_click";
    emit(eventType, { elementId: label.trim().replace(/\s+/g, " ").slice(0, 160) });
  }, true);

  document.addEventListener("play", (event) => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    emit("video_play", { elementId: video.getAttribute("data-track") || video.id || "video" });
  }, true);

  setInterval(() => {
    if (document.visibilityState === "visible" && Date.now() - lastActivity < 60_000) {
      emit("heartbeat", { durationMs: 15_000 });
    }
    const nextPage = location.pathname + location.search + location.hash;
    if (nextPage !== lastPage) { lastPage = nextPage; pageView(); }
  }, 15_000);

  addEventListener("pagehide", () => emit("session_end", { durationMs: 0 }, true));
})();`;

export function GET() {
  return new Response(tracker, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
