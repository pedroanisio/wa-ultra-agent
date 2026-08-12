import { test } from "node:test";
import assert from "node:assert/strict";

import { CONTEXT_BYTE_BUDGET, approximateTokens, describeSize, fitsInContext } from "../agent/lib/tool-output.ts";

/**
 * The guard that stops one tool result from spending the whole context window.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 * A turn died with `prompt is too long: 1123860 tokens > 1000000 maximum`. The
 * user had asked for a voice note; the model never got as far as choosing a
 * tool, so the failure looked like the voice feature being broken when it was a
 * context overflow with no attribution.
 *
 * Nothing had told anyone which payload was large, because nothing measured one.
 * A 3 MB attachment base64-encodes to ~4 MB of text — on its own, more than the
 * entire window — and the first sign of it was a 400 from the API.
 */

test("a small payload fits", () => {
  assert.equal(fitsInContext(50_000).ok, true);
});

test("a payload larger than the budget is refused", () => {
  assert.equal(fitsInContext(CONTEXT_BYTE_BUDGET + 1).ok, false);
});

test("the refusal says how big it was and what the limit is", () => {
  const verdict = fitsInContext(4 * 1024 * 1024);
  assert.equal(verdict.ok, false);
  // Naming the size is the whole point: "too long" without a number sends
  // someone hunting through every tool that ran.
  assert.match(verdict.reason!, /4(\.0)? MB/);
  assert.match(verdict.reason!, /MB/);
});

test("base64 inflation is counted, not the raw size", () => {
  // The bytes reaching the model are the ENCODED ones. Measuring the file
  // instead of its encoding under-counts by a third, which is exactly the
  // margin that turned a 3 MB cap into a blown window.
  const raw = 3 * 1024 * 1024;
  assert.ok(approximateTokens(raw, { base64: true }) > approximateTokens(raw, { base64: false }));
  assert.equal(fitsInContext(raw, { base64: true }).ok, false, "3 MB base64 must not fit");
});

test("the token estimate is in the right order of magnitude", () => {
  // ~4 characters per token. This does not need to be exact — it needs to be
  // right enough that a 4 MB payload is obviously over a 1M-token window.
  const tokens = approximateTokens(4 * 1024 * 1024, { base64: false });
  assert.ok(tokens > 500_000 && tokens < 2_000_000, `${tokens} is not a plausible estimate`);
});

test("sizes are described in units a person reads", () => {
  assert.match(describeSize(512), /512 B/);
  assert.match(describeSize(2048), /2(\.0)? KB/);
  assert.match(describeSize(5 * 1024 * 1024), /5(\.0)? MB/);
});

/* ── the tool that actually blew the window ────────────────────────── */

process.env.WA_BRIDGE_TOKEN ??= "test-token";
process.env.WA_BRIDGE_URL ??= "http://bridge.test";

const viewMedia = (await import("../agent/tools/whatsapp_view_media.ts")).default;

/** Answer /media with an attachment of `bytes`, base64-encoded as the bridge does. */
function fakeMedia(bytes: number, mediaType = "image/jpeg") {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        key: "3EB0",
        mediaType,
        sizeBytes: bytes,
        filename: "photo.jpg",
        base64: "A".repeat(Math.ceil((bytes * 4) / 3)),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  return () => void (globalThis.fetch = original);
}

test("an ordinary photo is still returned", async () => {
  const restore = fakeMedia(200 * 1024);
  try {
    const result = await viewMedia.execute({ key: "3EB0" }, {} as never);
    assert.equal(result.ok, true);
    assert.equal(result.tooLarge, false);
  } finally {
    restore();
  }
});

test("an attachment too big for the context is refused, not truncated", async () => {
  // Truncating would hand the model half a JPEG, which is not a smaller
  // picture — it is a corrupt one, described as if it were the real thing.
  const restore = fakeMedia(4 * 1024 * 1024);
  try {
    const result = await viewMedia.execute({ key: "3EB0" }, {} as never);

    assert.equal(result.tooLarge, true);
    assert.equal(result.base64, undefined, "the bytes must NOT reach the model");
  } finally {
    restore();
  }
});

test("the refusal tells the model what happened, in one readable line", async () => {
  const restore = fakeMedia(4 * 1024 * 1024);
  try {
    const result = await viewMedia.execute({ key: "3EB0" }, {} as never);
    const value = JSON.stringify(viewMedia.toModelOutput(result));

    assert.match(value, /4\.0 MB/, "the size is named");
    assert.match(value, /too large|limit/i);
  } finally {
    restore();
  }
});
