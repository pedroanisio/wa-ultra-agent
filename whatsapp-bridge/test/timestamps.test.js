import assert from "node:assert/strict";
import test from "node:test";

import { detectDateOrder, openStore, parseSentAt } from "../src/store.js";

/**
 * Reading a WhatsApp timestamp without knowing which number is the month.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 * `parseSentAt` required `DD/MM/YYYY HH:MM` — two digits per component, day
 * first. A live session renders `7/21/2026 19:41`: single-digit month, day
 * second. Every timestamp in the archive therefore failed to parse and was
 * stored as null, which silently disabled `since`/`until`, `order: "recent"`,
 * `bounds`, and every due-date calculation.
 *
 * ── Why this is not a one-line regex fix ────────────────────────────────────
 * `8/3/2026` is 3 August to a Brazilian and 8 March to an American, and nothing
 * in the string says which. Guessing does not produce a few wrong rows — it
 * silently reorders an entire history, which is the failure the original
 * comment in store.js warned about and the reason it returned null rather than
 * a guess. That instinct was right; only its assumption about the format was
 * wrong.
 *
 * So the order is DETECTED from the corpus rather than assumed. Any date with a
 * component above 12 settles it for every other date in the same account —
 * `7/21/2026` proves month-first, because 21 is not a month. An ambiguous date
 * with no evidence either way still returns null.
 */

/* ---------------------------------------------------------------- *
 * Unambiguous dates need no help
 * ---------------------------------------------------------------- */

test("a date whose second component exceeds 12 is month-first, whatever was declared", () => {
  // Real row: "[19:41, 7/21/2026] Joao Vitor Rocha: "
  assert.equal(parseSentAt("7/21/2026 19:41"), "2026-07-21T19:41:00.000Z");
  // The evidence in the string outranks a wrong declaration.
  assert.equal(parseSentAt("7/21/2026 19:41", { order: "day-first" }), "2026-07-21T19:41:00.000Z");
});

test("a date whose first component exceeds 12 is day-first, whatever was declared", () => {
  assert.equal(parseSentAt("21/7/2026 19:41"), "2026-07-21T19:41:00.000Z");
  assert.equal(parseSentAt("21/7/2026 19:41", { order: "month-first" }), "2026-07-21T19:41:00.000Z");
});

test("single-digit components parse — this is what broke", () => {
  assert.equal(parseSentAt("7/25/2026 01:08"), "2026-07-25T01:08:00.000Z");
  assert.equal(parseSentAt("1/2/2026 9:05", { order: "month-first" }), "2026-01-02T09:05:00.000Z");
});

test("zero-padded day-first still parses, as it always did", () => {
  assert.equal(parseSentAt("10/08/2026 14:30", { order: "day-first" }), "2026-08-10T14:30:00.000Z");
});

/* ---------------------------------------------------------------- *
 * Ambiguous dates refuse rather than guess
 * ---------------------------------------------------------------- */

test("an ambiguous date with no known order returns null rather than a guess", () => {
  // Real row: "8/3/2026 17:44". 3 August or 8 March — the string cannot say.
  // Guessing here reorders a history by five months and nothing reports it.
  assert.equal(parseSentAt("8/3/2026 17:44"), null);
});

test("an ambiguous date parses once the order is known, and the two differ", () => {
  assert.equal(parseSentAt("8/3/2026 17:44", { order: "month-first" }), "2026-08-03T17:44:00.000Z");
  assert.equal(parseSentAt("8/3/2026 17:44", { order: "day-first" }), "2026-03-08T17:44:00.000Z");
});

test("nonsense is still null", () => {
  assert.equal(parseSentAt("yesterday"), null);
  assert.equal(parseSentAt(undefined), null);
  assert.equal(parseSentAt(""), null);
  assert.equal(parseSentAt("16:45"), null, "a bare clock is not a timestamp");
  // Invalid either way round, so no order can rescue it.
  assert.equal(parseSentAt("13/13/2026 10:00", { order: "month-first" }), null);
  assert.equal(parseSentAt("31/2/2026 10:00", { order: "day-first" }), null, "February has no 31st");
});

/* ---------------------------------------------------------------- *
 * Detecting the order from the corpus
 * ---------------------------------------------------------------- */

test("order is detected from any sample with a component above 12", () => {
  // One unambiguous row settles it for the whole account.
  assert.equal(detectDateOrder(["8/3/2026 17:44", "7/21/2026 19:41"]), "month-first");
  assert.equal(detectDateOrder(["8/3/2026 17:44", "21/7/2026 19:41"]), "day-first");
});

test("order is undefined when every sample is ambiguous", () => {
  // Not a failure — a correct refusal. Everything stays undated until a row
  // arrives that settles it, which is better than dating it wrongly.
  assert.equal(detectDateOrder(["8/3/2026 17:44", "1/2/2026 09:00"]), undefined);
  assert.equal(detectDateOrder([]), undefined);
});

test("contradictory evidence resolves to nothing, never to a majority vote", () => {
  // Two chats rendered by different locales in one corpus. Picking the more
  // frequent one would date the minority wrongly and silently.
  assert.equal(detectDateOrder(["7/21/2026 19:41", "21/7/2026 19:41"]), undefined);
});

test("detection ignores strings that are not dates at all", () => {
  assert.equal(detectDateOrder(["16:45", "", null, undefined, "7/21/2026 19:41"]), "month-first");
});

/* ---------------------------------------------------------------- *
 * Ingestion applies the detected order to the whole window
 * ---------------------------------------------------------------- */

const row = (key, time) => ({ key, time, kind: "text", text: `msg ${key}`, from: "Fabio" });

test("ingest: one unambiguous row in the window dates the ambiguous ones with it", () => {
  const db = openStore(":memory:");
  // "7/21/2026" proves month-first, so "8/3/2026" is 3 August and not 8 March.
  db.upsertMessages("Fabio", [row("a", "8/3/2026 17:44"), row("b", "7/21/2026 19:41")]);

  const stored = Object.fromEntries(db.messagesFor("Fabio").map((m) => [m.key, m.sent_at_iso]));
  assert.equal(stored.b, "2026-07-21T19:41:00.000Z");
  assert.equal(stored.a, "2026-08-03T17:44:00.000Z", "dated by its neighbour's evidence");
  db.close();
});

test("ingest: a window with no evidence leaves the dates null rather than guessing", () => {
  const db = openStore(":memory:");
  db.upsertMessages("Fabio", [row("a", "8/3/2026 17:44"), row("b", "1/2/2026 09:00")]);

  for (const m of db.messagesFor("Fabio")) {
    assert.equal(m.sent_at_iso, null, "undated is honest; a guess would be invisible");
    assert.equal(m.sent_at, m.key === "a" ? "8/3/2026 17:44" : "1/2/2026 09:00", "raw text is kept");
  }
  db.close();
});

test("ingest: an operator-configured order settles a window that has no evidence", () => {
  const db = openStore(":memory:", { dateOrder: "month-first" });
  db.upsertMessages("Fabio", [row("a", "8/3/2026 17:44")]);

  assert.equal(db.messagesFor("Fabio")[0].sent_at_iso, "2026-08-03T17:44:00.000Z");
  db.close();
});

test("ingest: evidence in the window outranks a wrongly configured order", () => {
  const db = openStore(":memory:", { dateOrder: "day-first" });
  db.upsertMessages("Fabio", [row("a", "8/3/2026 17:44"), row("b", "7/21/2026 19:41")]);

  const stored = Object.fromEntries(db.messagesFor("Fabio").map((m) => [m.key, m.sent_at_iso]));
  assert.equal(stored.a, "2026-08-03T17:44:00.000Z", "the account's own rows beat the config");
  db.close();
});

test("ingest: re-reading a chat back-fills rows that were stored undated", () => {
  const db = openStore(":memory:");
  // First pass: nothing in the window settles the order, so it stays undated.
  db.upsertMessages("Fabio", [row("a", "8/3/2026 17:44")]);
  assert.equal(db.messagesFor("Fabio")[0].sent_at_iso, null);

  // A later window reaches a row that settles it. Re-reading is free because
  // messages are content-addressed, so the fix has to arrive on that path —
  // otherwise every row read before the evidence stays undated forever.
  db.upsertMessages("Fabio", [row("a", "8/3/2026 17:44"), row("b", "7/21/2026 19:41")]);

  const stored = Object.fromEntries(db.messagesFor("Fabio").map((m) => [m.key, m.sent_at_iso]));
  assert.equal(stored.a, "2026-08-03T17:44:00.000Z", "back-filled on the second pass");
  db.close();
});

test("ingest: a back-fill never overwrites a date that was already resolved", () => {
  const db = openStore(":memory:");
  db.upsertMessages("Fabio", [row("a", "7/21/2026 19:41")]);
  const before = db.messagesFor("Fabio")[0].sent_at_iso;

  // A later window whose evidence contradicts must not silently re-date it.
  db.upsertMessages("Fabio", [row("a", "7/21/2026 19:41"), row("b", "21/7/2026 19:41")]);

  assert.equal(db.messagesFor("Fabio").find((m) => m.key === "a").sent_at_iso, before);
  db.close();
});
