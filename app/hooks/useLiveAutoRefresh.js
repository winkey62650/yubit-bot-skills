"use client";

import { useEffect, useRef } from "react";
import { LIVE_STATUS_REFRESH_MS } from "../../lib/live-status.mjs";

export function useLiveAutoRefresh(callback, { enabled = true, intervalMs = LIVE_STATUS_REFRESH_MS } = {}) {
  const callbackRef = useRef(callback);
  const inFlightRef = useRef(false);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return undefined;
    const refresh = async () => {
      if (inFlightRef.current || document.visibilityState === "hidden") return;
      inFlightRef.current = true;
      try {
        await callbackRef.current();
      } finally {
        inFlightRef.current = false;
      }
    };
    const timer = window.setInterval(refresh, intervalMs);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, intervalMs]);
}
