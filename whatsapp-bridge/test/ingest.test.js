import { test } from "node:test";
import assert from "node:assert/strict";

import { ingestWith } from "../src/ingest.js";
import { openStore } from "../src/store.js";

/**
 * Ingestion is scrollback plus a write, and the interesting part is which of
 * the two modes is chosen.
 *
 * A top-up stops the moment it recognises a message it already has, so the
 * routine case — "what arrived since yesterday" — costs one or two scrolls
 * rather than a walk through the whole history. A backfill has nothing to stop
 * at and is bounded by scrolls and by the interaction budget instead.
 */

const store = () => openStore(":memory:", { dateOrder: "day-first", now: () => "2026-08-10T12:00:00.000Z" });

const msg = (key, over = {}) => ({
  key,
  kind: "text",
  from: "Helena",
  time: "10/08/2026 14:30",
  text: key,
  ...over,
});

function fakeScrollback(messages, extra = {}) {
  const calls = [];
  const fn = async (options) => {
    calls.push(options);
    return {
      chat: options.chat,
      messages,
      scrolls: 1,
      atTop: false,
      reachedKnown: false,
      budgetExhausted: false,
      hasMore: true,
      budgetRemaining: 99,
      ...extra,
    };
  };
  return { fn, calls };
}

test("writes what it collected and reports the counts", async () => {
  const db = store();
  const { fn } = fakeScrollback([msg("a"), msg("b")]);

  const result = await ingestWith({ scrollback: fn, store: db }, { chat: "Helena" });

  assert.equal(result.inserted, 2);
  assert.equal(result.duplicates, 0);
  assert.equal(db.stats().messages, 2);
  db.close();
});

test("running it twice writes nothing the second time", async () => {
  const db = store();
  const { fn } = fakeScrollback([msg("a"), msg("b")]);

  await ingestWith({ scrollback: fn, store: db }, { chat: "Helena" });
  const again = await ingestWith({ scrollback: fn, store: db }, { chat: "Helena" });

  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, 2);
  db.close();
});

test("a top-up stops at the newest message already stored", async () => {
  const db = store();
  db.upsertMessages("Helena", [msg("known", { time: "10/08/2026 14:30" })]);

  const { fn, calls } = fakeScrollback([msg("new")]);
  await ingestWith({ scrollback: fn, store: db }, { chat: "Helena", mode: "top-up" });

  assert.equal(calls[0].stopAtKey, "known");
  db.close();
});

test("a top-up on an empty archive has nothing to stop at", async () => {
  const db = store();
  const { fn, calls } = fakeScrollback([msg("a")]);

  await ingestWith({ scrollback: fn, store: db }, { chat: "Helena", mode: "top-up" });

  assert.equal(calls[0].stopAtKey, undefined);
  db.close();
});

test("a backfill deliberately does not stop at known messages", async () => {
  const db = store();
  db.upsertMessages("Helena", [msg("known")]);

  const { fn, calls } = fakeScrollback([msg("older")]);
  await ingestWith({ scrollback: fn, store: db }, { chat: "Helena", mode: "backfill" });

  assert.equal(calls[0].stopAtKey, undefined, "a backfill must be able to walk past what it has");
  db.close();
});

test("top-up is the default, because it is the cheap one", async () => {
  const db = store();
  db.upsertMessages("Helena", [msg("known")]);

  const { fn, calls } = fakeScrollback([msg("new")]);
  await ingestWith({ scrollback: fn, store: db }, { chat: "Helena" });

  assert.equal(calls[0].stopAtKey, "known");
  db.close();
});

test("passes the scroll allowance through", async () => {
  const db = store();
  const { fn, calls } = fakeScrollback([msg("a")]);

  await ingestWith({ scrollback: fn, store: db }, { chat: "Helena", maxScrolls: 7 });
  assert.equal(calls[0].maxScrolls, 7);
  db.close();
});

test("reports whether more remains, so a caller knows to run it again", async () => {
  const db = store();
  const { fn } = fakeScrollback([msg("a")], { atTop: true, hasMore: false });

  const result = await ingestWith({ scrollback: fn, store: db }, { chat: "Helena" });
  assert.equal(result.hasMore, false);
  assert.equal(result.atTop, true);
  db.close();
});

test("surfaces a budget stop as a resumable outcome, not a failure", async () => {
  const db = store();
  const { fn } = fakeScrollback([msg("a")], { budgetExhausted: true, hasMore: true });

  const result = await ingestWith({ scrollback: fn, store: db }, { chat: "Helena" });

  assert.equal(result.budgetExhausted, true);
  assert.equal(result.inserted, 1, "what was collected before the stop is still written");
  db.close();
});

test("reports the archive's reach after writing", async () => {
  const db = store();
  const { fn } = fakeScrollback([
    msg("old", { time: "01/08/2026 09:00" }),
    msg("new", { time: "10/08/2026 14:30" }),
  ]);

  const result = await ingestWith({ scrollback: fn, store: db }, { chat: "Helena" });

  assert.equal(result.bounds.count, 2);
  assert.equal(result.bounds.newestKey, "new");
  assert.equal(result.bounds.oldestKey, "old");
  db.close();
});
