import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/store.js";

/**
 * What period the archive covers, and windowing an obligation by when it was
 * SAID.
 *
 * Both come from one exchange the agent could not answer. Asked what period it
 * was considering, it could only report a count — 8,824 messages in 203
 * conversations — and asked for the oldest date it said plainly that it could
 * not see one. Neither was a prompt problem: the numbers were not in the store.
 */

const store = () => openStore(":memory:", { dateOrder: "day-first", now: () => "2026-08-10T12:00:00.000Z" });

const msg = (over = {}) => ({
  key: "k1",
  kind: "text",
  from: "Helena",
  time: "10/08/2026 14:30",
  text: "a reunião mudou para quinta",
  outgoing: false,
  ...over,
});

const item = (over = {}) => ({
  type: "commitment",
  statement: "send the proposal",
  actor: "me",
  sourceMessageKey: "k1",
  ...over,
});

test("span: reports the oldest and newest message, and the days between", () => {
  const db = store();
  db.upsertMessages("Helena", [
    msg({ key: "old", time: "03/06/2026 09:00" }),
    msg({ key: "mid", time: "01/07/2026 09:00" }),
    msg({ key: "new", time: "10/08/2026 14:30" }),
  ]);

  const span = db.stats().span;

  assert.match(span.oldest, /^2026-06-03/);
  assert.match(span.newest, /^2026-08-10/);
  assert.equal(span.days, 68);
  assert.equal(span.dated, 3);
  assert.equal(span.undated, 0);
  db.close();
});

test("span: an empty archive has no period rather than a wrong one", () => {
  const db = store();

  const span = db.stats().span;

  assert.equal(span.oldest, null);
  assert.equal(span.newest, null);
  assert.equal(span.days, 0);
  db.close();
});

test("span: messages whose timestamp would not parse are counted, not hidden", () => {
  // The bounds come from the dated rows, so an undated row is invisible to
  // MIN/MAX. Quoting the span without saying how many rows it cannot see turns
  // a claim about part of the archive into a claim about all of it.
  const db = store();
  db.upsertMessages("Helena", [
    msg({ key: "dated", time: "10/08/2026 14:30" }),
    msg({ key: "undated", time: "" }),
  ]);

  const span = db.stats().span;

  assert.equal(span.dated, 1);
  assert.equal(span.undated, 1);
  assert.match(span.oldest, /^2026-08-10/);
  db.close();
});

test("span: one day of messages is a one-day span, never a zero-day one", () => {
  const db = store();
  db.upsertMessages("Helena", [
    msg({ key: "a", time: "10/08/2026 09:00" }),
    msg({ key: "b", time: "10/08/2026 18:00" }),
  ]);

  assert.equal(db.stats().span.days, 1);
  db.close();
});

test("obligations: `since` windows by when it was SAID, which is the question asked", () => {
  const db = store();
  db.upsertMessages("Helena", [
    msg({ key: "old", time: "01/06/2026 09:00" }),
    msg({ key: "recent", time: "05/08/2026 09:00" }),
  ]);
  db.addExtractions([
    item({ sourceMessageKey: "old", statement: "the June promise" }),
    item({ sourceMessageKey: "recent", statement: "the August promise" }),
  ]);

  const lastFortyFive = db.extractions({ since: "2026-06-26T00:00:00.000Z" });

  assert.equal(lastFortyFive.length, 1);
  assert.equal(lastFortyFive[0].statement, "the August promise");
  db.close();
});

test("obligations: `until` closes the window at the other end", () => {
  const db = store();
  db.upsertMessages("Helena", [
    msg({ key: "old", time: "01/06/2026 09:00" }),
    msg({ key: "recent", time: "05/08/2026 09:00" }),
  ]);
  db.addExtractions([
    item({ sourceMessageKey: "old", statement: "the June promise" }),
    item({ sourceMessageKey: "recent", statement: "the August promise" }),
  ]);

  const upToJuly = db.extractions({ until: "2026-07-01T00:00:00.000Z" });

  assert.equal(upToJuly.length, 1);
  assert.equal(upToJuly[0].statement, "the June promise");
  db.close();
});

test("obligations: the said-window is not the due-window", () => {
  // An item promised last week and due next month is IN "the last 45 days" and
  // OUT of "due before today". Filtering the first question with the second is
  // how a real obligation disappears from a list that claims to be complete.
  const db = store();
  db.upsertMessages("Helena", [msg({ key: "recent", time: "05/08/2026 09:00" })]);
  db.addExtractions([item({ sourceMessageKey: "recent", dueAt: "2026-12-01" })]);

  assert.equal(db.extractions({ since: "2026-06-26T00:00:00.000Z" }).length, 1);
  assert.equal(db.extractions({ dueBefore: "2026-08-10" }).length, 0);
  db.close();
});
