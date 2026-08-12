import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { createTransport } from "../src/transport.js";

/**
 * The pairing stream, driven against a real socket.
 *
 * ── Why this is not a unit test ─────────────────────────────────────────────
 * Everything that can go wrong here is a property of the SEAM. The stream never
 * ends, so a client that awaits the body hangs until pairing times out; the code
 * rotates every twenty seconds, so a chunk held in a buffer is a code that has
 * already expired by the time it is drawn; and the upstream connection has to
 * close when the reader leaves, or the transport is left holding a QR channel
 * and the next attempt to pair finds one already running.
 *
 * None of those are visible in a function that returns a Response. All three are
 * visible here.
 */

/** Set per test: what the fake transport does when /pair/qr is opened. */
let onQrRequest = () => {};
/** Resolves when the fake transport sees its request end. */
let upstreamClosed;
let markUpstreamClosed;
let server;
let baseUrl;

before(async () => {
  server = createServer((req, res) => {
    if (req.url !== "/pair/qr") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== "Bearer test-token") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    req.on("close", () => markUpstreamClosed());
    onQrRequest(res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

function transport() {
  upstreamClosed = new Promise((resolve) => {
    markUpstreamClosed = resolve;
  });
  return createTransport({ baseUrl, token: "test-token" });
}

/** Read `count` SSE data payloads off a stream, then stop reading. */
async function readCodes(response, count) {
  const codes = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (const line of buffer.split("\n")) {
      const match = /^data: (.*)$/.exec(line.trim());
      if (match && !codes.includes(match[1])) codes.push(match[1]);
    }
    if (codes.length >= count) break;
  }
  return codes;
}

test("each rotation arrives as it is emitted, not when the stream ends", async () => {
  // The stream is open-ended by design. Anything that waits for it to finish
  // waits for the pairing to expire, which is the whole failure this shape
  // exists to avoid.
  onQrRequest = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: code-one\n\n");
    setTimeout(() => res.write("data: code-two\n\n"), 10);
    // Deliberately never ended.
  };

  const response = await transport().pairQrStream();
  const codes = await readCodes(response, 2);
  assert.deepEqual(codes, ["code-one", "code-two"]);
});

test("leaving the stream closes the upstream request", async () => {
  // Otherwise a browser that navigated away leaves a QR channel open on the
  // transport, and the next attempt to pair finds one already running.
  onQrRequest = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: code-one\n\n");
  };

  const controller = new AbortController();
  const client = transport();
  const response = await client.pairQrStream(controller.signal);
  await readCodes(response, 1);
  controller.abort();

  await upstreamClosed;
});

test("a refusal is an error with the transport's own status, not an empty stream", async () => {
  onQrRequest = (res) => {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "already paired" }));
  };

  await assert.rejects(
    () => transport().pairQrStream(),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /already paired/);
      return true;
    },
  );
});

test("a wrong token fails here rather than producing a stream that never emits", async () => {
  onQrRequest = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: should-not-be-reached\n\n");
  };

  const wrong = createTransport({ baseUrl, token: "not-the-token" });
  await assert.rejects(
    () => wrong.pairQrStream(),
    (error) => error.statusCode === 401,
  );
});
