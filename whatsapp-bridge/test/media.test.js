import { test } from "node:test";
import assert from "node:assert/strict";

import { messageKey } from "../src/history.js";
import {
  DOWNLOADABLE_KINDS,
  assertDownloadable,
  assertWithinCap,
  fetchMediaWith,
  mediaTypeFor,
  resolveTarget,
} from "../src/media.js";

/**
 * Media is addressed by position — "the third message from the end" — because
 * this build of WhatsApp Web renders no stable per-message id. Position is
 * inherently racy: one new message arriving shifts every index by one.
 *
 * So the caller states what it expects to find there, and the bridge refuses if
 * the row has changed underneath it. Same shape as the self-chat assertion:
 * verify, then act, never the other way round.
 */

const rows = [
  { fromEnd: 3, kind: "text", from: "Helena", time: "10/08/2026 14:30", text: "oi" },
  { fromEnd: 2, kind: "voice", from: "Helena", time: "10/08/2026 14:31", text: "[voice note · 3:42]" },
  { fromEnd: 1, kind: "document", from: "Helena", time: "10/08/2026 14:32", text: "[document · escola.pdf]", media: { filename: "escola.pdf" } },
  { fromEnd: 0, kind: "image", from: "Joao", time: "10/08/2026 14:33", text: "[image]" },
];

/* ---------------------------------------------------------------- *
 * Target resolution — the safety-critical part
 * ---------------------------------------------------------------- */

test("target: finds the row at the requested position", () => {
  assert.equal(resolveTarget(rows, { fromEnd: 2 }).kind, "voice");
});

test("target: refuses a position that is not in the window", () => {
  assert.throws(() => resolveTarget(rows, { fromEnd: 99 }), (e) => e.statusCode === 404);
});

test("target: accepts a matching expected kind", () => {
  assert.doesNotThrow(() => resolveTarget(rows, { fromEnd: 2, expect: { kind: "voice" } }));
});

test("target: refuses when the kind at that position has changed", () => {
  assert.throws(
    () => resolveTarget(rows, { fromEnd: 2, expect: { kind: "image" } }),
    (e) => e.statusCode === 409 && /voice/.test(e.message) && /image/.test(e.message),
  );
});

test("target: refuses when the sender at that position has changed", () => {
  assert.throws(
    () => resolveTarget(rows, { fromEnd: 2, expect: { kind: "voice", from: "Fabio" } }),
    (e) => e.statusCode === 409,
  );
});

test("target: refuses when the timestamp has changed, which means messages shifted", () => {
  assert.throws(
    () => resolveTarget(rows, { fromEnd: 2, expect: { kind: "voice", time: "10/08/2026 09:00" } }),
    (e) => e.statusCode === 409,
  );
});

test("target: an absent expectation is allowed but is not a match either way", () => {
  assert.doesNotThrow(() => resolveTarget(rows, { fromEnd: 1, expect: {} }));
});

/* ---------------------------------------------------------------- *
 * What can be downloaded at all
 * ---------------------------------------------------------------- */

test("downloadable: media kinds are allowed", () => {
  for (const kind of DOWNLOADABLE_KINDS) assert.doesNotThrow(() => assertDownloadable(kind));
});

test("downloadable: a text message has no payload to fetch", () => {
  assert.throws(() => assertDownloadable("text"), (e) => e.statusCode === 400);
});

test("downloadable: system, deleted, poll, location and contact rows are refused", () => {
  for (const kind of ["system", "deleted", "poll", "location", "contact"]) {
    assert.throws(() => assertDownloadable(kind), (e) => e.statusCode === 400, `${kind} must be refused`);
  }
});

test("downloadable: an unknown row is refused with a pointer to the debug route", () => {
  assert.throws(
    () => assertDownloadable("unknown"),
    (e) => e.statusCode === 400 && /debug/i.test(e.message),
  );
});

/* ---------------------------------------------------------------- *
 * Size — a base64 payload is re-sent on every model call
 * ---------------------------------------------------------------- */

test("cap: allows a payload under the limit", () => {
  assert.doesNotThrow(() => assertWithinCap(1000, 2000));
});

test("cap: refuses a payload over the limit and names both numbers", () => {
  assert.throws(
    () => assertWithinCap(5_000_000, 3_000_000),
    (e) => e.statusCode === 413 && /4\.8 MB/.test(e.message) && /2\.9 MB/.test(e.message),
  );
});

/* ---------------------------------------------------------------- *
 * Media types
 * ---------------------------------------------------------------- */

test("mediaType: read from the filename extension when there is one", () => {
  assert.equal(mediaTypeFor("escola.pdf", "document"), "application/pdf");
  assert.equal(mediaTypeFor("foto.JPG", "image"), "image/jpeg");
  assert.equal(mediaTypeFor("nota.ogg", "voice"), "audio/ogg");
});

test("mediaType: falls back to the kind when there is no usable filename", () => {
  assert.equal(mediaTypeFor(undefined, "voice"), "audio/ogg");
  assert.equal(mediaTypeFor(undefined, "image"), "image/jpeg");
  assert.equal(mediaTypeFor(undefined, "sticker"), "image/webp");
  assert.equal(mediaTypeFor("no-extension", "document"), "application/octet-stream");
});

/* ---------------------------------------------------------------- *
 * Orchestration
 * ---------------------------------------------------------------- */

function spyDeps(overrides = {}) {
  const calls = { opened: [], downloaded: [] };
  const deps = {
    openChat: async (name) => {
      calls.opened.push(name);
      return { opened: name, exactMatch: true };
    },
    readRows: async () => rows,
    downloadRow: async (target) => {
      calls.downloaded.push(target.fromEnd);
      return { buffer: Buffer.from("hello"), suggestedFilename: "escola.pdf" };
    },
    ...overrides,
  };
  return { deps, calls };
}

test("fetch: returns the payload, its type and its size", async () => {
  const { deps } = spyDeps();
  const result = await fetchMediaWith(deps, { chat: "Helena", fromEnd: 1, expect: { kind: "document" } });

  assert.equal(result.kind, "document");
  assert.equal(result.mediaType, "application/pdf");
  assert.equal(result.filename, "escola.pdf");
  assert.equal(result.sizeBytes, 5);
  assert.equal(Buffer.from(result.base64, "base64").toString(), "hello");
});

test("fetch: refuses a changed row and downloads nothing", async () => {
  const { deps, calls } = spyDeps();

  await assert.rejects(
    () => fetchMediaWith(deps, { chat: "Helena", fromEnd: 1, expect: { kind: "voice" } }),
    (e) => e.statusCode === 409,
  );
  assert.deepEqual(calls.downloaded, [], "nothing may be fetched after a failed match");
});

test("fetch: refuses a non-media row before opening the browser download", async () => {
  const { deps, calls } = spyDeps();

  await assert.rejects(
    () => fetchMediaWith(deps, { chat: "Helena", fromEnd: 3 }),
    (e) => e.statusCode === 400,
  );
  assert.deepEqual(calls.downloaded, []);
});

test("fetch: enforces the size cap after download and reports the kind", async () => {
  const { deps } = spyDeps({
    downloadRow: async () => ({ buffer: Buffer.alloc(9_000), suggestedFilename: "big.pdf" }),
  });

  await assert.rejects(
    () => fetchMediaWith(deps, { chat: "Helena", fromEnd: 1, maxBytes: 1_000 }),
    (e) => e.statusCode === 413,
  );
});

test("fetch: reports the chat it actually opened", async () => {
  const { deps } = spyDeps({
    openChat: async () => ({ opened: "Helena Souto", exactMatch: false }),
  });

  const result = await fetchMediaWith(deps, { chat: "Helena", fromEnd: 1 });
  assert.equal(result.chat, "Helena Souto");
  assert.equal(result.exactMatch, false);
});

test("fetch: prefers the row's own filename over the browser's suggestion", async () => {
  const { deps } = spyDeps({
    downloadRow: async () => ({ buffer: Buffer.from("x"), suggestedFilename: "download (1).bin" }),
  });

  const result = await fetchMediaWith(deps, { chat: "Helena", fromEnd: 1 });
  assert.equal(result.filename, "escola.pdf");
});

/* ------------------------------------------------------------------ *
 * The archive key.
 *
 * `fromEnd` addresses a position and expires the moment a message arrives.
 * A transcript has to be filed against the message itself, so the payload
 * carries the same content-addressed key ingestion would have written — and
 * "the same" is the whole property worth testing, because a key computed
 * differently here would file every transcript against nothing.
 * ------------------------------------------------------------------ */

test("fetch: carries the archive key for the row it actually fetched", async () => {
  const { deps } = spyDeps();

  const result = await fetchMediaWith(deps, { chat: "Helena", fromEnd: 1 });

  assert.ok(result.key, "a media payload must be filable against its message");
  assert.equal(result.key.length, 16);
});

test("fetch: the key is the one ingestion would have stored", async () => {
  const { deps } = spyDeps();

  const result = await fetchMediaWith(deps, { chat: "Helena", fromEnd: 1 });
  const target = rows.find((row) => row.fromEnd === 1);

  // Computed from the resolved chat name, not the requested one: ingestion
  // stores under the chat WhatsApp opened, and a key computed from "Helena"
  // when the archive holds "Helena Souto" cites a message that does not exist.
  assert.equal(result.key, messageKey(result.chat, target));
});

test("fetch: a different row yields a different key", async () => {
  const { deps } = spyDeps();

  const one = await fetchMediaWith(deps, { chat: "Helena", fromEnd: 1 });
  const other = await fetchMediaWith(deps, { chat: "Helena", fromEnd: 2 });

  assert.notEqual(one.key, other.key);
});
