import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_BODY_CHARS, composeSelfNote } from "../agent/lib/self-note.ts";

/**
 * The body is what the user long-presses and copies on their phone. WhatsApp's
 * Copy takes a whole message, so the body must arrive alone and verbatim — no
 * label, no quotes, no "here is your draft". Every test here is a variation on
 * that one requirement.
 */

test("body only: one message, trimmed", () => {
  assert.deepEqual(composeSelfNote({ body: "  Oi Fabio  " }), ["Oi Fabio"]);
});

test("body and context: two messages, context first", () => {
  const messages = composeSelfNote({
    body: "Oi Fabio, mando amanhã.",
    context: "Fabio asked for the numbers",
    kind: "draft",
  });

  assert.equal(messages.length, 2);
  assert.match(messages[0], /Fabio asked for the numbers/);
  assert.equal(messages[1], "Oi Fabio, mando amanhã.");
});

test("the body message is never decorated", () => {
  const body = "Oi Fabio, mando amanhã.";
  for (const kind of ["draft", "digest", "extract", "transcript", "reminder", "note"] as const) {
    const messages = composeSelfNote({ body, context: "anything", kind });
    assert.equal(messages.at(-1), body, `${kind} must not alter the body`);
  }
});

test("the body keeps its newlines, emoji and internal spacing", () => {
  const body = "Linha um\n\nLinha  dois 🎯\n- item";
  assert.deepEqual(composeSelfNote({ body }), [body]);
});

test("kind labels the context line so it is scannable on a phone", () => {
  assert.match(composeSelfNote({ body: "b", context: "c", kind: "draft" })[0], /^Draft/);
  assert.match(composeSelfNote({ body: "b", context: "c", kind: "digest" })[0], /^Digest/);
  assert.match(composeSelfNote({ body: "b", context: "c", kind: "reminder" })[0], /^Reminder/);
  assert.match(composeSelfNote({ body: "b", context: "c", kind: "transcript" })[0], /^Transcript/);
});

test("kind defaults to note", () => {
  assert.match(composeSelfNote({ body: "b", context: "c" })[0], /^Note/);
});

test("a blank context is treated as absent rather than sent as an empty line", () => {
  assert.deepEqual(composeSelfNote({ body: "b", context: "   " }), ["b"]);
});

test("never composes more than two messages", () => {
  const messages = composeSelfNote({
    body: "b".repeat(3000),
    context: "c".repeat(500),
    kind: "digest",
  });
  assert.ok(messages.length <= 2);
});

test("rejects an empty body", () => {
  assert.throws(() => composeSelfNote({ body: "" }), /body/i);
});

test("rejects a whitespace-only body", () => {
  assert.throws(() => composeSelfNote({ body: "  \n  " }), /body/i);
});

test(`rejects a body longer than ${MAX_BODY_CHARS} chars`, () => {
  assert.throws(() => composeSelfNote({ body: "x".repeat(MAX_BODY_CHARS + 1) }), /\d+/);
});

test("rejects an over-long context rather than silently truncating it", () => {
  assert.throws(() => composeSelfNote({ body: "b", context: "c".repeat(MAX_BODY_CHARS + 1) }));
});
