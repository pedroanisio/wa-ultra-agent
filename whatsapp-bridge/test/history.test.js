import { test } from "node:test";
import assert from "node:assert/strict";

import { createBudget } from "../src/rate.js";
import { dedupeByKey, messageKey, scrollbackWith } from "../src/history.js";

/**
 * Backfilling a chat means scrolling its pane upward and re-reading, because
 * the conversation virtualises: only what is on screen exists in the DOM.
 *
 * Two properties make that safe to repeat. Messages are identified by their
 * content, so re-ingesting the same window twice writes nothing new; and every
 * scroll costs an interaction from the bridge's budget, so a backfill paces
 * itself instead of racing through a decade of history.
 */

const msg = (over = {}) => ({
  kind: "text",
  from: "Helena",
  time: "10/08/2026 14:30",
  text: "oi",
  ...over,
});

/* ---------------------------------------------------------------- *
 * Identity
 * ---------------------------------------------------------------- */

test("key: the same message yields the same key, so re-reading is idempotent", () => {
  assert.equal(messageKey("Helena", msg()), messageKey("Helena", msg()));
});

test("key: differs when the text differs", () => {
  assert.notEqual(messageKey("Helena", msg()), messageKey("Helena", msg({ text: "tchau" })));
});

test("key: differs when the sender differs", () => {
  assert.notEqual(messageKey("Helena", msg()), messageKey("Helena", msg({ from: "Joao" })));
});

test("key: differs when the time differs", () => {
  assert.notEqual(messageKey("Helena", msg()), messageKey("Helena", msg({ time: "10/08/2026 14:31" })));
});

test("key: the same text in two chats is two different messages", () => {
  assert.notEqual(messageKey("Helena", msg()), messageKey("Fabio", msg()));
});

test("key: tolerates missing time and sender", () => {
  assert.ok(messageKey("Helena", { kind: "system", text: "TODAY" }).length > 0);
});

test("key: is short enough to store and compare cheaply", () => {
  assert.match(messageKey("Helena", msg()), /^[0-9a-f]{16}$/);
});

test("dedupe: keeps the first occurrence and preserves order", () => {
  const a = { key: "1", text: "a" };
  const b = { key: "2", text: "b" };
  assert.deepEqual(dedupeByKey([a, b, { ...a }]), [a, b]);
});

/* ---------------------------------------------------------------- *
 * Scrollback
 * ---------------------------------------------------------------- */

function spyDeps(windows, { maxPerHour = 100 } = {}) {
  const calls = { reads: 0, scrolls: 0 };
  const budget = createBudget({ maxPerHour, now: () => 1_000_000 });
  const deps = {
    budget,
    readMessages: async () => windows[Math.min(calls.reads++, windows.length - 1)],
    scrollUp: async () => {
      calls.scrolls++;
    },
  };
  return { deps, calls, budget };
}

test("reads once and stops when no scrolling is asked for", async () => {
  const { deps, calls } = spyDeps([[msg({ text: "a" })]]);
  const result = await scrollbackWith(deps, { chat: "Helena", maxScrolls: 0 });

  assert.equal(result.messages.length, 1);
  assert.equal(calls.scrolls, 0);
  assert.equal(result.hasMore, true, "not scrolling proves nothing about the top");
});

test("collects older messages across scrolls, oldest first", async () => {
  const { deps } = spyDeps([
    [msg({ text: "c" })],
    [msg({ text: "b" }), msg({ text: "c" })],
    [msg({ text: "a" }), msg({ text: "b" }), msg({ text: "c" })],
  ]);

  const result = await scrollbackWith(deps, { chat: "Helena", maxScrolls: 2 });
  assert.deepEqual(result.messages.map((m) => m.text), ["a", "b", "c"]);
});

test("overlapping windows are merged, never duplicated", async () => {
  const { deps } = spyDeps([
    [msg({ text: "b" }), msg({ text: "c" })],
    [msg({ text: "a" }), msg({ text: "b" }), msg({ text: "c" })],
  ]);

  const result = await scrollbackWith(deps, { chat: "Helena", maxScrolls: 1 });
  assert.equal(result.messages.length, 3);
});

test("every returned message carries its key", async () => {
  const { deps } = spyDeps([[msg()]]);
  const result = await scrollbackWith(deps, { chat: "Helena", maxScrolls: 0 });

  assert.equal(result.messages[0].key, messageKey("Helena", msg()));
});

test("stops at the top of the history when a scroll reveals nothing new", async () => {
  const { deps, calls } = spyDeps([
    [msg({ text: "b" })],
    [msg({ text: "a" }), msg({ text: "b" })],
    [msg({ text: "a" }), msg({ text: "b" })], // nothing older exists
  ]);

  const result = await scrollbackWith(deps, { chat: "Helena", maxScrolls: 5 });
  assert.equal(result.atTop, true);
  assert.equal(result.hasMore, false);
  assert.equal(calls.scrolls, 2, "stops as soon as the top is proven, not at maxScrolls");
});

test("stops at maxScrolls and reports that more remains", async () => {
  let n = 0;
  const { deps } = spyDeps([]);
  deps.readMessages = async () => [msg({ text: `m${n++}` })];

  const result = await scrollbackWith(deps, { chat: "Helena", maxScrolls: 3 });
  assert.equal(result.hasMore, true);
  assert.equal(result.atTop, false);
  assert.equal(result.scrolls, 3);
});

test("stops early on reaching an already-ingested message", async () => {
  const known = messageKey("Helena", msg({ text: "b" }));
  const { deps, calls } = spyDeps([
    [msg({ text: "c" })],
    [msg({ text: "b" }), msg({ text: "c" })],
    [msg({ text: "a" }), msg({ text: "b" }), msg({ text: "c" })],
  ]);

  const result = await scrollbackWith(deps, { chat: "Helena", maxScrolls: 5, stopAtKey: known });
  assert.equal(result.reachedKnown, true);
  assert.equal(result.hasMore, false);
  assert.equal(calls.scrolls, 1, "an incremental top-up must not walk the whole history");
});

/* ---------------------------------------------------------------- *
 * The budget is not advisory
 * ---------------------------------------------------------------- */

test("spends one interaction per read and per scroll", async () => {
  const { deps, budget } = spyDeps([[msg({ text: "b" })], [msg({ text: "a" }), msg({ text: "b" })]]);
  const before = budget.remaining();

  await scrollbackWith(deps, { chat: "Helena", maxScrolls: 1 });

  // read, scroll, read
  assert.equal(before - budget.remaining(), 3);
});

test("stops cleanly when the budget runs out, returning what it already has", async () => {
  let n = 0;
  const { deps } = spyDeps([], { maxPerHour: 3 });
  deps.readMessages = async () => [msg({ text: `m${n++}` })];

  const result = await scrollbackWith(deps, { chat: "Helena", maxScrolls: 50 });

  assert.equal(result.budgetExhausted, true);
  assert.equal(result.hasMore, true, "there is more, we are just not allowed to fetch it now");
  assert.ok(result.messages.length > 0, "work already done is not thrown away");
});

test("refuses outright when there is no budget for even the first read", async () => {
  const { deps, budget } = spyDeps([[msg()]], { maxPerHour: 1 });
  budget.take(1);

  await assert.rejects(
    () => scrollbackWith(deps, { chat: "Helena", maxScrolls: 1 }),
    (e) => e.statusCode === 429,
  );
});
