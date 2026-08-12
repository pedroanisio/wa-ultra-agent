import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  assertSelfNoteConfigured,
  assertSelfNoteEnabled,
  normalizeMessages,
  sendSelfNoteWith,
} from "../src/self-note.js";

/**
 * The self-note path exists because it cannot reach a third party. Every test
 * below is really one assertion restated: a note is written to the configured
 * self chat, or it is not written at all.
 */

const NAME = "Joao (You)";
const okEnv = { WA_SELF_CHAT_NAME: NAME };

/** Records sends so a test can assert that nothing was written on a refusal. */
function spyDeps(overrides = {}) {
  const calls = { sent: [] };
  const deps = {
    env: okEnv,
    send: async (message) => {
      calls.sent.push(message);
      return { id: `id-${calls.sent.length}` };
    },
    ...overrides,
  };
  return { deps, calls };
}

/* ---------------------------------------------------------------- *
 * Configuration
 * ---------------------------------------------------------------- */

test("configuration: returns the configured self-chat name", () => {
  assert.equal(assertSelfNoteConfigured({ WA_SELF_CHAT_NAME: NAME }), NAME);
});

test("configuration: is enabled by default, so only the name is required", () => {
  assert.equal(assertSelfNoteConfigured({ WA_SELF_CHAT_NAME: NAME }), NAME);
});

test("configuration: refuses when explicitly disabled", () => {
  assert.throws(
    () => assertSelfNoteConfigured({ ...okEnv, WA_ALLOW_SELF_NOTE: "false" }),
    (e) => e.statusCode === 403 && /WA_ALLOW_SELF_NOTE/.test(e.message),
  );
});

test("configuration: refuses when the self-chat name is unset", () => {
  assert.throws(
    () => assertSelfNoteConfigured({}),
    (e) => e.statusCode === 403 && /WA_SELF_CHAT_NAME/.test(e.message),
  );
});

test("configuration: refuses when the self-chat name is only whitespace", () => {
  assert.throws(
    () => assertSelfNoteConfigured({ WA_SELF_CHAT_NAME: "   " }),
    (e) => e.statusCode === 403,
  );
});

test("configuration: trims the configured name", () => {
  assert.equal(assertSelfNoteConfigured({ WA_SELF_CHAT_NAME: `  ${NAME}  ` }), NAME);
});

/* ---------------------------------------------------------------- *
 * Message validation
 * ---------------------------------------------------------------- */

test("messages: accepts a single message and trims it", () => {
  assert.deepEqual(normalizeMessages(["  hello  "]), ["hello"]);
});

test("messages: accepts two messages and preserves their order", () => {
  assert.deepEqual(normalizeMessages(["context", "body"]), ["context", "body"]);
});

test("messages: rejects an empty array", () => {
  assert.throws(() => normalizeMessages([]), (e) => e.statusCode === 400);
});

test("messages: rejects a non-array", () => {
  assert.throws(() => normalizeMessages("hello"), (e) => e.statusCode === 400);
});

test(`messages: rejects more than ${MAX_MESSAGES}, so a digest cannot become a burst`, () => {
  assert.throws(
    () => normalizeMessages(["a", "b", "c"]),
    // The refusal used to cite browser interactions. The cap survived the
    // browser because its real reason did: each message is its own notification
    // on the operator's phone.
    (e) => e.statusCode === 400 && /burst/i.test(e.message),
  );
});

test("messages: rejects a whitespace-only entry rather than sending a blank line", () => {
  assert.throws(() => normalizeMessages(["ok", "   "]), (e) => e.statusCode === 400);
});

test(`messages: rejects an entry longer than ${MAX_MESSAGE_CHARS} chars`, () => {
  assert.throws(
    () => normalizeMessages(["x".repeat(MAX_MESSAGE_CHARS + 1)]),
    (e) => e.statusCode === 400,
  );
});

test("messages: preserves newlines and emoji inside a message verbatim", () => {
  const body = "linha um\nlinha dois 🎯";
  assert.deepEqual(normalizeMessages([body]), [body]);
});

/* ---------------------------------------------------------------- *
 * Orchestration
 *
 * The safety-critical comparison this section used to hold — that the OPEN chat
 * is exactly the configured one — is gone, and its absence is the point. It
 * existed because `openChat()` typed into a search box and clicked the first
 * result, so "Joao" could open "Joao Antunes". The transport addresses the
 * account's own JID, read from the device store and never taken from a caller,
 * so there is no name to mis-resolve and nothing left to compare.
 * ---------------------------------------------------------------- */

test("send: writes a single message", async () => {
  const { deps, calls } = spyDeps();
  const result = await sendSelfNoteWith(deps, { messages: ["body"] });

  assert.equal(result.sent, 1);
  assert.deepEqual(calls.sent, ["body"]);
});

test("send: writes context then body, in that order, as separate messages", async () => {
  const { deps, calls } = spyDeps();
  await sendSelfNoteWith(deps, { messages: ["Draft \u00b7 Fabio", "Oi Fabio"] });

  assert.deepEqual(calls.sent, ["Draft \u00b7 Fabio", "Oi Fabio"]);
});

test("send: takes no recipient, so no caller can redirect a note", async () => {
  const { deps, calls } = spyDeps();
  await sendSelfNoteWith(deps, { messages: ["body"] });

  // The dependency is `send(message)`: there is no address parameter to pass.
  assert.equal(deps.send.length, 1);
  assert.deepEqual(calls.sent, ["body"]);
});

test("send: writes nothing when the feature is switched off", async () => {
  const { deps, calls } = spyDeps({ env: { WA_ALLOW_SELF_NOTE: "false" } });

  await assert.rejects(
    () => sendSelfNoteWith(deps, { messages: ["body"] }),
    (e) => e.statusCode === 403,
  );
  assert.deepEqual(calls.sent, [], "a refusal must not write");
});

test("send: validates every message before writing any of them", async () => {
  const { deps, calls } = spyDeps();

  await assert.rejects(
    () => sendSelfNoteWith(deps, { messages: ["fine", ""] }),
    (e) => e.statusCode === 400,
  );
  assert.deepEqual(calls.sent, [], "a partial note is worse than none");
});

test("send: refuses more messages than the cap, and writes none", async () => {
  const { deps, calls } = spyDeps();

  await assert.rejects(
    () => sendSelfNoteWith(deps, { messages: ["a", "b", "c"] }),
    (e) => e.statusCode === 400,
  );
  assert.deepEqual(calls.sent, []);
});

test("configuration: the off switch alone gates the transport path", () => {
  // WA_SELF_CHAT_NAME no longer routes anything, so the send path asks only
  // whether the feature is enabled. assertSelfNoteConfigured still exists for
  // callers that want the configured title itself.
  assert.doesNotThrow(() => assertSelfNoteEnabled({}));
  assert.throws(
    () => assertSelfNoteEnabled({ WA_ALLOW_SELF_NOTE: "false" }),
    (e) => e.statusCode === 403,
  );
});
