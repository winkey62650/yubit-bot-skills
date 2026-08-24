import http from "node:http";
import https from "node:https";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_REDIRECTS = 3;

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("Binary download aborted.");
}

export async function downloadBinary(url, options = {}) {
  const target = new URL(String(url || ""));
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Binary download URL must use HTTP or HTTPS.");
  }
  const signal = options.signal;
  signal?.throwIfAborted?.();
  const maxBytes = Math.max(1, Number(options.maxBytes || DEFAULT_MAX_BYTES));
  const timeoutMs = Math.max(1, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const redirectsRemaining = Number.isInteger(options.redirectsRemaining)
    ? options.redirectsRemaining
    : DEFAULT_REDIRECTS;

  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const request = transport.get(target, {
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
        "User-Agent": "Yubit-Content-Distribution/1.0",
      },
    }, (response) => {
      const status = Number(response.statusCode || 0);
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          finish(reject, new Error("Binary download exceeded the redirect limit."));
          return;
        }
        downloadBinary(new URL(location, target), {
          ...options,
          redirectsRemaining: redirectsRemaining - 1,
        }).then((value) => finish(resolve, value), (error) => finish(reject, error));
        return;
      }

      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          const error = new Error(`Binary download exceeded ${maxBytes} bytes.`);
          response.destroy();
          finish(reject, error);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(resolve, new Response(Buffer.concat(chunks), {
        status: status || 500,
        headers: response.headers,
      })));
      response.on("error", (error) => finish(reject, error));
    });

    const onAbort = () => request.destroy(abortReason(signal));
    signal?.addEventListener?.("abort", onAbort, { once: true });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Binary download timed out after ${timeoutMs}ms.`)));
    request.on("error", (error) => finish(reject, error));
  });
}
