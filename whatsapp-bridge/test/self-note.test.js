import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  assertSelfChatOpen,
  assertSelfNoteConfigured,
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

/** Records calls so a test can assert that nothing was typed on a refusal. */
function spyDeps(overrides = {}) {
  const calls = { openChat: [], typed: [] };
  const deps = {
    env: okEnv,
    openChatTitle: async () => NAME,
    openChat: async (q) => {
      calls.openChat.push(q);
      return { opened: q, exactMatch: true, contains: true };
    },
    typeAndSend: async (text) => {
      calls.typed.push(text);
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
    (e) => e.statusCode === 400 && /interaction/i.test(e.message),
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
 * The open-chat assertion — the safety-critical comparison
 * ---------------------------------------------------------------- */

test("assertion: passes on an exact match", () => {
  assert.doesNotThrow(() => assertSelfChatOpen(NAME, NAME));
});

test("assertion: refuses a prefix of the expected name", () => {
  assert.throws(() => assertSelfChatOpen("Joao", NAME), (e) => e.statusCode === 409);
});

test("assertion: refuses a name that merely contains the expected one", () => {
  assert.throws(
    () => assertSelfChatOpen("Joao (You) and family", NAME),
    (e) => e.statusCode === 409,
  );
});

test("assertion: refuses a case-only difference", () => {
  assert.throws(() => assertSelfChatOpen("joao (you)", NAME), (e) => e.statusCode === 409);
});

test("assertion: refuses an empty title, which means no chat is open", () => {
  assert.throws(() => assertSelfChatOpen("", NAME), (e) => e.statusCode === 409);
});

test("assertion: names both strings so the failure is diagnosable", () => {
  assert.throws(
    () => assertSelfChatOpen("Ana Paula", NAME),
    (e) => e.message.includes("Ana Paula") && e.message.includes(NAME),
  );
});

/* ---------------------------------------------------------------- *
 * Orchestration
 * ---------------------------------------------------------------- */

test("send: writes a single message when the self chat is already open", async () => {
  const { deps, calls } = spyDeps();
  const result = await sendSelfNoteWith(deps, { messages: ["body"] });

  assert.equal(result.sent, true);
  assert.equal(result.chat, NAME);
  assert.deepEqual(calls.typed, ["body"]);
  assert.deepEqual(calls.openChat, [], "no navigation needed when already open");
});

test("send: writes context then body, in that order, as separate messages", async () => {
  const { deps, calls } = spyDeps();
  await sendSelfNoteWith(deps, { messages: ["Draft · Fabio", "Oi Fabio"] });

  assert.deepEqual(calls.typed, ["Draft · Fabio", "Oi Fabio"]);
});

test("send: navigates to the self chat when another chat is open", async () => {
  let title = "Helena";
  const { deps, calls } = spyDeps({
    openChatTitle: async () => title,
    openChat: async (q) => {
      calls.openChat.push(q);
      title = NAME;
      return { opened: NAME, exactMatch: true, contains: true };
    },
  });

  await sendSelfNoteWith(deps, { messages: ["body"] });

  assert.deepEqual(calls.openChat, [NAME]);
  assert.deepEqual(calls.typed, ["body"]);
});

test("send: refuses when navigation lands on a different chat, and types nothing", async () => {
  const { deps, calls } = spyDeps({
    openChatTitle: async () => "Helena",
    openChat: async (q) => {
      calls.openChat.push(q);
      // The fuzzy search matched a similarly-named contact instead.
      return { opened: "Joao Peixoto", exactMatch: false, contains: true };
    },
  });

  await assert.rejects(
    () => sendSelfNoteWith(deps, { messages: ["private draft"] }),
    (e) => e.statusCode === 409,
  );
  assert.deepEqual(calls.typed, [], "nothing may be typed after a failed resolution");
});

test("send: refuses when openChat claims success but the header disagrees", async () => {
  const { deps, calls } = spyDeps({
    // Never becomes the self chat, however confident openChat is.
    openChatTitle: async () => "Helena",
    openChat: async (q) => {
      calls.openChat.push(q);
      return { opened: NAME, exactMatch: true, contains: true };
    },
  });

  await assert.rejects(
    () => sendSelfNoteWith(deps, { messages: ["private draft"] }),
    (e) => e.statusCode === 409,
  );
  assert.deepEqual(calls.typed, []);
});

test("send: checks configuration before touching the browser", async () => {
  let touched = false;
  const { deps } = spyDeps({
    env: {},
    openChatTitle: async () => {
      touched = true;
      return NAME;
    },
  });

  await assert.rejects(() => sendSelfNoteWith(deps, { messages: ["body"] }), (e) => e.statusCode === 403);
  assert.equal(touched, false, "a missing env var must not report a WhatsApp problem");
});

test("send: validates messages before touching the browser", async () => {
  let touched = false;
  const { deps } = spyDeps({
    openChatTitle: async () => {
      touched = true;
      return NAME;
    },
  });

  await assert.rejects(() => sendSelfNoteWith(deps, { messages: [] }), (e) => e.statusCode === 400);
  assert.equal(touched, false);
});

test("send: reports what it wrote, for the caller to echo back", async () => {
  const { deps } = spyDeps();
  const result = await sendSelfNoteWith(deps, { messages: ["a", "b"] });

  assert.deepEqual(result.messages, ["a", "b"]);
  assert.equal(result.chat, NAME);
  assert.ok(Date.parse(result.at), "at is an ISO timestamp");
});

test("send: stops at the first failure rather than continuing the sequence", async () => {
  const { deps, calls } = spyDeps({
    typeAndSend: async (text) => {
      calls.typed.push(text);
      if (calls.typed.length === 1) throw new Error("composer vanished");
    },
  });

  await assert.rejects(() => sendSelfNoteWith(deps, { messages: ["first", "second"] }));
  assert.deepEqual(calls.typed, ["first"], "the second message must not be attempted");
});
