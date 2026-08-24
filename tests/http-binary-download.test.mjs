import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { downloadBinary } from "../lib/http-binary-download.mjs";

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("binary downloader follows redirects and preserves image metadata", async () => {
  await withServer((request, response) => {
    if (request.url === "/poster") {
      response.writeHead(302, { location: "/asset.png" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "image/png" });
    response.end(Buffer.from("poster-bytes"));
  }, async (baseUrl) => {
    const response = await downloadBinary(`${baseUrl}/poster`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "poster-bytes");
  });
});

test("binary downloader rejects payloads above its byte limit", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(Buffer.alloc(2_048));
  }, async (baseUrl) => {
    await assert.rejects(
      downloadBinary(`${baseUrl}/asset.png`, { maxBytes: 1_024 }),
      /exceeded 1024 bytes/,
    );
  });
});
