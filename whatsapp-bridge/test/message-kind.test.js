import { test } from "node:test";
import assert from "node:assert/strict";

import { placeholderText } from "../src/message-kind.js";

/**
 * The wording the model reads when a message has no text of its own.
 *
 * ── What this file used to be ───────────────────────────────────────────────
 * Four hundred lines, most of them exercising `classifyRow` against DOM rows
 * captured from a live session — icon names, localized aria-labels, and the
 * "0:29\n1×\n16:46" ambiguity where a voice note's duration and its clock have
 * the same shape. All of it went with the browser: the protocol states a
 * message's kind, author, instant and duration as fields, so there is nothing
 * left to infer from a rendering, and `classifyRow` had no caller in `src/`.
 *
 * Two things were gained by deleting it rather than leaving it green. The
 * captured rows carried a real correspondent's name in a public repository. And
 * a passing test suite for a function nothing calls is a claim that the
 * behaviour still matters, which is how dead code survives review.
 *
 * What remains is the part that is load-bearing. `placeholderText` is the shared
 * vocabulary between the bridge, the archive and a second implementation in Go —
 * `test/transport.test.js` asserts the two agree — so its output is a stored
 * format, not a formatting detail. A label that changed here would split one
 * kind of message into two spellings inside the same archive.
 */

test("names the kind and the duration", () => {
  assert.equal(placeholderText({ kind: "voice", durationSeconds: 222 }), "[voice note · 3:42]");
});

test("omits an unknown duration rather than printing 0:00", () => {
  // A voice note whose length did not survive is still a voice note. "[voice
  // note · 0:00]" would read as a message that was never recorded.
  assert.equal(placeholderText({ kind: "voice" }), "[voice note]");
});

test("writes an hour-long duration with padded minutes", () => {
  assert.equal(placeholderText({ kind: "audio", durationSeconds: 3723 }), "[audio · 1:02:03]");
});

test("names a document by its filename", () => {
  assert.equal(placeholderText({ kind: "document", filename: "boleto.pdf" }), "[document · boleto.pdf]");
});

test("appends a caption when there is one", () => {
  // The caption IS the message. Dropping it would turn a photo someone wrote a
  // sentence about into a bare "[image]".
  assert.equal(placeholderText({ kind: "image", caption: "olha isso" }), "[image] olha isso");
});

test("a caption survives alongside a duration", () => {
  assert.equal(
    placeholderText({ kind: "video", durationSeconds: 15, caption: "no mar" }),
    "[video · 0:15] no mar",
  );
});

test("an unknown kind says so in words the model can repeat", () => {
  assert.match(placeholderText({ kind: "unknown" }), /unrecognised/i);
});

test("an unknown kind carries whatever label was found", () => {
  assert.equal(
    placeholderText({ kind: "unknown", label: "Live location" }),
    "[unrecognised attachment · Live location]",
  );
});

test("a kind with no label of its own still renders as something", () => {
  // Never an empty string: `text` is what the model reads, and empty is
  // indistinguishable from silence. A kind this file has not heard of — a new
  // one from the protocol — must degrade to a readable line, not to nothing.
  const text = placeholderText({ kind: "some_future_kind" });
  assert.ok(text.trim().length > 0);
  assert.match(text, /unrecognised/i);
});

test("called with nothing at all, it still returns a readable line", () => {
  assert.ok(placeholderText().trim().length > 0);
});

test("every protocol kind the bridge files has its own wording", () => {
  // These arrived when the transport stopped filing them as `unknown`. A kind
  // that falls back to "unrecognised attachment" here is one the archive stores
  // as unreadable even though the protocol named it.
  const PROTOCOL_KINDS = [
    "reaction", "video_note", "album", "poll_vote", "event",
    "pinned", "kept", "group_invite", "comment", "call_log",
    "business", "payment", "location", "contact", "poll", "sticker", "gif",
  ];
  const unnamed = PROTOCOL_KINDS.filter((kind) => /unrecognised/.test(placeholderText({ kind })));
  assert.deepEqual(unnamed, [], `kinds with no wording of their own: ${unnamed.join(", ")}`);
});
