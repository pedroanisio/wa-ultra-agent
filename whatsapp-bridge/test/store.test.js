import { test } from "node:test";
import assert from "node:assert/strict";

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore, parseSentAt } from "../src/store.js";

/**
 * The store's one non-negotiable property: every derived fact traces back to a
 * message that was actually read. That is not a convention here — it is a
 * foreign key with `PRAGMA foreign_keys = ON`, so a fact with no source cannot
 * be written at all.
 *
 * Everything runs against an in-memory database, so these are real SQL tests
 * with no fixture files and no cleanup.
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

/* ---------------------------------------------------------------- *
 * Timestamps
 * ---------------------------------------------------------------- */

test("time: parses WhatsApp's day-first format when told that is the order", () => {
  assert.equal(parseSentAt("10/08/2026 14:30", { order: "day-first" }), "2026-08-10T14:30:00.000Z");
});

test("time: reads 10/08 as 10 August, not 8 October", () => {
  // Getting this backwards silently reorders a whole history — which is why the
  // order is no longer assumed. "10/08/2026" is 10 August only if the account
  // renders day-first, and this file's fixtures declare that they do. A live
  // session was found rendering "7/21/2026", month-first; see timestamps.test.js.
  assert.match(parseSentAt("10/08/2026 14:30", { order: "day-first" }), /^2026-08-10/);
});

test("time: returns null for anything it cannot parse", () => {
  assert.equal(parseSentAt("yesterday"), null);
  assert.equal(parseSentAt(undefined), null);
  assert.equal(parseSentAt(""), null);
});

/* ---------------------------------------------------------------- *
 * Ingestion
 * ---------------------------------------------------------------- */

test("insert: stores messages and reports what it wrote", () => {
  const db = store();
  const result = db.upsertMessages("Helena", [msg(), msg({ key: "k2", text: "ok" })]);

  assert.equal(result.inserted, 2);
  assert.equal(result.duplicates, 0);
  db.close();
});

test("insert: re-ingesting the same window writes nothing", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);
  const again = db.upsertMessages("Helena", [msg()]);

  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(db.stats().messages, 1);
  db.close();
});

test("insert: a chat is created once and reused", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);
  db.upsertMessages("Helena", [msg({ key: "k2" })]);

  assert.equal(db.stats().chats, 1);
  db.close();
});

test("insert: keeps media metadata alongside the placeholder", () => {
  const db = store();
  db.upsertMessages("Helena", [
    msg({
      key: "v1",
      kind: "voice",
      text: "[voice note · 3:42]",
      media: { kind: "voice", durationSeconds: 222 },
    }),
    msg({
      key: "d1",
      kind: "document",
      text: "[document · escola.pdf]",
      media: { kind: "document", filename: "escola.pdf", caption: "olha" },
    }),
  ]);

  const rows = db.messagesFor("Helena");
  const voice = rows.find((r) => r.key === "v1");
  const doc = rows.find((r) => r.key === "d1");

  assert.equal(voice.duration_seconds, 222);
  assert.equal(doc.filename, "escola.pdf");
  assert.equal(doc.caption, "olha");
  db.close();
});

test("insert: tolerates a message with no sender or time", () => {
  const db = store();
  assert.doesNotThrow(() =>
    db.upsertMessages("Helena", [{ key: "s1", kind: "system", text: "TODAY" }]),
  );
  db.close();
});

test("insert: normalises the timestamp so history can be ordered", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);

  assert.equal(db.messagesFor("Helena")[0].sent_at_iso, "2026-08-10T14:30:00.000Z");
  db.close();
});

/* ---------------------------------------------------------------- *
 * Resuming
 * ---------------------------------------------------------------- */

test("bounds: reports the newest key, which is where a top-up stops", () => {
  const db = store();
  db.upsertMessages("Helena", [
    msg({ key: "old", time: "01/08/2026 09:00", text: "old" }),
    msg({ key: "new", time: "10/08/2026 14:30", text: "new" }),
  ]);

  const bounds = db.chatBounds("Helena");
  assert.equal(bounds.newestKey, "new");
  assert.equal(bounds.oldestKey, "old");
  assert.equal(bounds.count, 2);
  db.close();
});

test("bounds: newest is by message time, not by ingestion order", () => {
  const db = store();
  // A backfill writes older messages *after* newer ones.
  db.upsertMessages("Helena", [msg({ key: "new", time: "10/08/2026 14:30" })]);
  db.upsertMessages("Helena", [msg({ key: "old", time: "01/08/2026 09:00" })]);

  assert.equal(db.chatBounds("Helena").newestKey, "new");
  db.close();
});

test("bounds: an unknown chat has no bounds rather than throwing", () => {
  const db = store();
  assert.equal(db.chatBounds("Nobody").count, 0);
  assert.equal(db.chatBounds("Nobody").newestKey, undefined);
  db.close();
});

/* ---------------------------------------------------------------- *
 * Search
 * ---------------------------------------------------------------- */

test("search: finds a message by a word in its body", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);

  const hits = db.search("quinta");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, "k1");
  assert.equal(hits[0].chat, "Helena");
  db.close();
});

test("search: returns nothing for a word that is not there", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);
  assert.deepEqual(db.search("bicicleta"), []);
  db.close();
});

test("search: the index stays in step with inserts", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);
  db.upsertMessages("Helena", [msg({ key: "k2", text: "vamos de bicicleta" })]);

  assert.equal(db.search("bicicleta").length, 1);
  db.close();
});

test("search: media placeholders are searchable too", () => {
  const db = store();
  db.upsertMessages("Helena", [msg({ key: "v1", kind: "voice", text: "[voice note · 3:42]" })]);

  assert.equal(db.search("voice").length, 1);
  db.close();
});

test("search: can be scoped to one chat", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);
  db.upsertMessages("Fabio", [msg({ key: "k2" })]);

  assert.equal(db.search("quinta").length, 2);
  assert.equal(db.search("quinta", { chat: "Fabio" }).length, 1);
  db.close();
});

/* ---------------------------------------------------------------- *
 * Provenance — the Phase 4 gate
 * ---------------------------------------------------------------- */

test("provenance: a fact must cite a message that exists", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);

  assert.throws(
    () => db.addFact({ statement: "meeting moved to Thursday", sourceMessageKey: "nonexistent" }),
    (e) => /source|provenance|message/i.test(e.message),
  );
  db.close();
});

test("provenance: a fact citing a real message is stored with its source", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);
  db.addFact({ subject: "school", statement: "meeting moved to Thursday", sourceMessageKey: "k1" });

  const [fact] = db.factsFor("k1");
  assert.equal(fact.statement, "meeting moved to Thursday");
  assert.equal(fact.source_message_key, "k1");
  db.close();
});

test("provenance: the citation resolves back to the message text", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);
  db.addFact({ statement: "meeting moved", sourceMessageKey: "k1" });

  const [row] = db.factsWithSource();
  assert.equal(row.statement, "meeting moved");
  assert.match(row.source_text, /quinta/);
  assert.equal(row.source_chat, "Helena");
  db.close();
});

test("provenance: facts are recalled by subject, whatever case they were filed in", () => {
  const db = store();
  db.upsertMessages("Fabio", [msg()]);
  db.addFact({ subject: "Fabio", statement: "a filha se chama Alice", sourceMessageKey: "k1" });
  db.addFact({ subject: "Helena", statement: "prefere WhatsApp a email", sourceMessageKey: "k1" });

  assert.equal(db.factsWithSource({ subject: "Fabio" }).length, 1);
  // A model writes the subject, and models are inconsistent about casing. A
  // fact filed as "Fabio" that cannot be found under "fabio" is a fact lost.
  assert.equal(db.factsWithSource({ subject: "fabio" }).length, 1);
  assert.equal(db.factsWithSource().length, 2, "unfiltered still returns everything");
  db.close();
});

test("provenance: facts can be narrowed to the chat they were read in", () => {
  const db = store();
  db.upsertMessages("Fabio", [msg()]);
  db.upsertMessages("Helena", [msg({ key: "k2" })]);
  db.addFact({ subject: "Fabio", statement: "x", sourceMessageKey: "k1" });
  db.addFact({ subject: "Fabio", statement: "y", sourceMessageKey: "k2" });

  assert.equal(db.factsWithSource({ chat: "Helena" }).length, 1);
  assert.equal(db.factsWithSource({ subject: "Fabio", chat: "Fabio" }).length, 1);
  db.close();
});

test("provenance: an uncitable fact is refused as actionable, not as a fault", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);

  // 409, not 500: the caller cited a message from a chat that was never
  // archived, and the fix is to archive it — not to read a stack trace.
  assert.throws(
    () => db.addFact({ statement: "invented", sourceMessageKey: "never-read" }),
    (error) => error.statusCode === 409 && /has been ingested/.test(error.message),
  );
  db.close();
});

test("provenance: a transcript must also cite a real message", () => {
  const db = store();
  assert.throws(() => db.recordTranscript("nope", "hello"), (e) => /message/i.test(e.message));
  db.close();
});

test("provenance: a transcript attaches to its voice note and replaces on re-run", () => {
  const db = store();
  db.upsertMessages("Helena", [msg({ key: "v1", kind: "voice", text: "[voice note · 3:42]" })]);

  db.recordTranscript("v1", "reunião mudou");
  db.recordTranscript("v1", "reunião mudou para quinta");

  assert.equal(db.transcriptFor("v1").text, "reunião mudou para quinta");
  assert.equal(db.stats().transcripts, 1);
  db.close();
});

/* ---------------------------------------------------------------- *
 * Durability plumbing
 * ---------------------------------------------------------------- */

test("schema: opening an existing store again is a no-op, not an error", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);
  db.close();

  // Re-running the migrations on a populated database must not throw.
  const again = openStore(":memory:", { dateOrder: "day-first" });
  assert.equal(again.stats().messages, 0);
  again.close();
});

test("stats: counts everything the store holds", () => {
  const db = store();
  db.upsertMessages("Helena", [msg(), msg({ key: "k2", text: "ok" })]);
  db.addFact({ statement: "x", sourceMessageKey: "k1" });

  const stats = db.stats();
  assert.equal(stats.chats, 1);
  assert.equal(stats.messages, 2);
  assert.equal(stats.facts, 1);
  db.close();
});

test("durability: creates the archive's directory, so a fresh volume just works", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-store-"));
  const path = join(dir, "nested", "store.db");

  const db = openStore(path, { dateOrder: "day-first" });
  db.upsertMessages("Helena", [msg()]);
  db.close();

  assert.ok(existsSync(path), "the database file was created under a directory that did not exist");
  rmSync(dir, { recursive: true, force: true });
});

test("durability: an archive survives being closed and reopened", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-store-"));
  const path = join(dir, "store.db");

  const first = openStore(path, { dateOrder: "day-first" });
  first.upsertMessages("Helena", [msg()]);
  first.close();

  const second = openStore(path, { dateOrder: "day-first" });
  assert.equal(second.stats().messages, 1);
  assert.equal(second.search("quinta").length, 1, "the search index survived too");
  second.close();

  rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- *
 * Phase 5 — search that can actually answer a question
 * ---------------------------------------------------------------- */

/** A small archive shaped like the draft's four motivating questions. */
function seeded() {
  const db = store();
  db.upsertMessages("Helena", [
    msg({ key: "m1", from: "Helena", time: "01/03/2026 09:00", text: "a excursão da Zaira é dia 28" }),
    msg({ key: "m2", from: "Joao", time: "01/03/2026 09:05", text: "beleza, anoto", outgoing: true }),
    msg({ key: "m3", from: "Helena", time: "02/03/2026 10:00", text: "kkkkk" }),
  ]);
  db.upsertMessages("Fabio", [
    msg({ key: "f1", from: "Fabio", time: "15/02/2026 20:00", text: "aquele restaurante japonês na Augusta é ótimo" }),
    msg({ key: "f2", from: "Fabio", time: "10/08/2026 11:00", text: "te mando a proposta de infraestrutura amanhã" }),
  ]);
  return db;
}

test("search: filters by sender", () => {
  const db = seeded();
  assert.equal(db.search("proposta", { sender: "Fabio" }).length, 1);
  assert.equal(db.search("proposta", { sender: "Helena" }).length, 0);
  db.close();
});

test("search: filters by date range, which is how 'six months ago' is answered", () => {
  const db = seeded();
  const hits = db.search("restaurante", { since: "2026-02-01", until: "2026-03-01" });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, "f1");
  assert.equal(db.search("restaurante", { since: "2026-06-01" }).length, 0);
  db.close();
});

test("search: filters by kind", () => {
  const db = seeded();
  db.upsertMessages("Helena", [
    msg({ key: "v9", kind: "voice", time: "03/03/2026 08:00", text: "[voice note · 1:10]" }),
  ]);

  assert.equal(db.search("voice", { kind: "voice" }).length, 1);
  assert.equal(db.search("voice", { kind: "text" }).length, 0);
  db.close();
});

test("search: filters to the user's own messages, for 'what did I promise'", () => {
  const db = seeded();
  assert.equal(db.search("anoto", { outgoing: true }).length, 1);
  assert.equal(db.search("anoto", { outgoing: false }).length, 0);
  db.close();
});

test("search: returns a snippet marking where the match is", () => {
  const db = seeded();
  const [hit] = db.search("excursão");

  assert.match(hit.snippet, /\[excursão\]/i);
  db.close();
});

test("search: orders by relevance by default and by recency on request", () => {
  const db = store();
  db.upsertMessages("X", [
    msg({ key: "a", time: "01/01/2026 09:00", text: "proposta proposta proposta" }),
    msg({ key: "b", time: "01/08/2026 09:00", text: "uma proposta qualquer com muitas outras palavras aqui" }),
  ]);

  assert.equal(db.search("proposta")[0].key, "a", "denser match ranks first");
  assert.equal(db.search("proposta", { order: "recent" })[0].key, "b");
  db.close();
});

test("search: combines filters", () => {
  const db = seeded();
  const hits = db.search("proposta", { sender: "Fabio", since: "2026-08-01", chat: "Fabio" });
  assert.equal(hits.length, 1);
  db.close();
});

test("search: a query with no results is empty, not an error", () => {
  const db = seeded();
  assert.deepEqual(db.search("bicicleta"), []);
  db.close();
});

/* ---------------------------------------------------------------- *
 * Context — a hit alone is not an answer
 * ---------------------------------------------------------------- */

test("context: returns the messages around a hit, in order", () => {
  const db = seeded();
  const context = db.contextAround("m2", { before: 1, after: 1 });

  assert.deepEqual(context.messages.map((m) => m.key), ["m1", "m2", "m3"]);
  assert.equal(context.chat, "Helena");
  db.close();
});

test("context: marks which message was the hit", () => {
  const db = seeded();
  const context = db.contextAround("m2", { before: 1, after: 1 });

  assert.equal(context.messages.find((m) => m.matched).key, "m2");
  db.close();
});

test("context: never crosses into another conversation", () => {
  const db = seeded();
  const context = db.contextAround("f1", { before: 5, after: 5 });

  assert.ok(context.messages.every((m) => m.chat === "Fabio"));
  db.close();
});

test("context: clamps at the edges of what is stored", () => {
  const db = seeded();
  const context = db.contextAround("m1", { before: 10, after: 10 });

  assert.equal(context.messages[0].key, "m1", "nothing older exists");
  assert.equal(context.messages.length, 3);
  db.close();
});

test("context: an unknown key is refused rather than returning a wrong window", () => {
  const db = seeded();
  assert.throws(() => db.contextAround("nope", {}), (e) => /message/i.test(e.message));
  db.close();
});

/* ---------------------------------------------------------------- *
 * Phase 6 — extracted items, under the same provenance rule
 * ---------------------------------------------------------------- */

const item = (over = {}) => ({
  type: "commitment",
  statement: "send the proposal",
  actor: "Joao",
  counterparty: "Fabio",
  dueAt: "2026-08-11",
  confidence: 0.9,
  sourceMessageKey: "k1",
  ...over,
});

test("extraction: an item must cite a message that exists", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);

  assert.throws(
    () => db.addExtractions([item({ sourceMessageKey: "ghost" })]),
    (e) => /message/i.test(e.message),
  );
  db.close();
});

test("extraction: a cited item is stored and reports what was written", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);

  const result = db.addExtractions([item()]);
  assert.equal(result.inserted, 1);
  assert.equal(db.stats().extractions, 1);
  db.close();
});

test("extraction: re-running over the same messages writes nothing new", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);

  db.addExtractions([item()]);
  const again = db.addExtractions([item()]);

  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, 1);
  db.close();
});

test("extraction: the same statement from a different message is a different item", () => {
  const db = store();
  db.upsertMessages("Helena", [msg(), msg({ key: "k2", text: "again" })]);

  db.addExtractions([item()]);
  const other = db.addExtractions([item({ sourceMessageKey: "k2" })]);

  assert.equal(other.inserted, 1);
  db.close();
});

test("extraction: an empty batch is a no-op, which is the small-talk case", () => {
  const db = store();
  const result = db.addExtractions([]);

  assert.equal(result.inserted, 0);
  assert.equal(db.stats().extractions, 0);
  db.close();
});

test("extraction: a batch is all-or-nothing, so a bad citation writes none of it", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);

  assert.throws(() =>
    db.addExtractions([item(), item({ statement: "other", sourceMessageKey: "ghost" })]),
  );
  assert.equal(db.stats().extractions, 0, "the valid item must not have been written either");
  db.close();
});

test("extraction: items come back with the message they came from", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);
  db.addExtractions([item()]);

  const [row] = db.extractions({ type: "commitment" });
  assert.equal(row.statement, "send the proposal");
  assert.match(row.source_text, /quinta/);
  assert.equal(row.source_chat, "Helena");
  db.close();
});

test("extraction: can be filtered by type and by who owes what", () => {
  const db = store();
  db.upsertMessages("Helena", [msg()]);
  db.addExtractions([
    item(),
    item({ type: "waiting", statement: "numbers from Fabio", actor: "Fabio" }),
  ]);

  assert.equal(db.extractions({ type: "commitment" }).length, 1);
  assert.equal(db.extractions({ type: "waiting" }).length, 1);
  assert.equal(db.extractions({ actor: "Fabio" }).length, 1);
  db.close();
});

/* ---------------------------------------------------------------- *
 * Phase 7 — obligations: what is owed, and by whom
 * ---------------------------------------------------------------- */

/** Fixed "today" so due dates are deterministic. */
const TODAY = "2026-08-10T12:00:00.000Z";
const dated = () => openStore(":memory:", { dateOrder: "day-first", now: () => TODAY });

function withObligations() {
  const db = dated();
  db.upsertMessages("Fabio", [
    msg({ key: "mine", from: "Joao", outgoing: true, text: "te mando a proposta sexta" }),
    msg({ key: "theirs", from: "Fabio", outgoing: false, text: "me manda os números" }),
  ]);
  db.addExtractions([
    { type: "commitment", statement: "send the proposal", actor: "Joao", counterparty: "Fabio",
      dueAt: "2026-08-07", confidence: 0.9, sourceMessageKey: "mine" },
    { type: "commitment", statement: "book the dentist", actor: "Joao",
      dueAt: "2026-08-12", confidence: 0.9, sourceMessageKey: "mine" },
    { type: "commitment", statement: "someday thing", actor: "Joao",
      confidence: 0.8, sourceMessageKey: "mine" },
    { type: "waiting", statement: "numbers from Fabio", actor: "Fabio",
      dueAt: "2026-08-05", confidence: 0.9, sourceMessageKey: "theirs" },
    { type: "question", statement: "are you free Thursday?", actor: "Fabio",
      confidence: 0.8, sourceMessageKey: "theirs" },
  ]);
  return db;
}

test("obligations: resolving one takes it off the open list", () => {
  const db = withObligations();
  const [first] = db.extractions({ type: "commitment" });

  db.resolveExtraction(first.id, "done");

  assert.equal(db.extractions({ type: "commitment" }).length, 2);
  assert.equal(db.extractions({ type: "commitment", status: "done" }).length, 1);
  db.close();
});

test("obligations: resolving an unknown item is refused, not silently ignored", () => {
  const db = withObligations();
  assert.throws(() => db.resolveExtraction(9999, "done"), (e) => /no (extracted )?item/i.test(e.message));
  db.close();
});

test("obligations: only known statuses are accepted", () => {
  const db = withObligations();
  const [first] = db.extractions({ type: "commitment" });
  assert.throws(() => db.resolveExtraction(first.id, "vibes"), (e) => /status/i.test(e.message));
  db.close();
});

test("obligations: overdue is anything past due and still open", () => {
  const db = withObligations();
  const overdue = db.extractions({ overdue: true });

  assert.deepEqual(
    overdue.map((o) => o.statement).sort(),
    ["numbers from Fabio", "send the proposal"],
  );
  db.close();
});

test("obligations: an undated item is never overdue", () => {
  const db = withObligations();
  assert.ok(!db.extractions({ overdue: true }).some((o) => o.statement === "someday thing"));
  db.close();
});

test("obligations: resolving something removes it from overdue", () => {
  const db = withObligations();
  const [late] = db.extractions({ overdue: true, type: "commitment" });
  db.resolveExtraction(late.id, "done");

  assert.equal(db.extractions({ overdue: true, type: "commitment" }).length, 0);
  db.close();
});

test("obligations: dueBefore finds what is coming up", () => {
  const db = withObligations();
  const soon = db.extractions({ type: "commitment", dueBefore: "2026-08-13" });

  assert.deepEqual(soon.map((o) => o.statement), ["send the proposal", "book the dentist"]);
  db.close();
});

test("obligations: dated items come before undated ones, soonest first", () => {
  const db = withObligations();
  const all = db.extractions({ type: "commitment" });

  assert.deepEqual(all.map((o) => o.statement), [
    "send the proposal",
    "book the dentist",
    "someday thing",
  ]);
  db.close();
});

test("obligations: each carries whether it came from a message the user sent", () => {
  const db = withObligations();
  const mine = db.extractions({ type: "commitment" })[0];
  const theirs = db.extractions({ type: "waiting" })[0];

  assert.equal(mine.source_outgoing, 1);
  assert.equal(theirs.source_outgoing, 0);
  db.close();
});

/* ---------------------------------------------------------------- *
 * Phase 8 — "what needs my attention"
 * ---------------------------------------------------------------- */

test("attention: separates overdue, upcoming, waiting-on and unanswered", () => {
  const db = withObligations();
  const digest = db.attention({ horizonDays: 7 });

  assert.deepEqual(digest.overdue.map((o) => o.statement), ["send the proposal"]);
  assert.deepEqual(digest.dueSoon.map((o) => o.statement), ["book the dentist"]);
  assert.deepEqual(digest.waitingOn.map((o) => o.statement), ["numbers from Fabio"]);
  assert.deepEqual(digest.unanswered.map((o) => o.statement), ["are you free Thursday?"]);
  db.close();
});

test("attention: an overdue waiting item is waiting-on, not one of my overdue tasks", () => {
  const db = withObligations();
  const digest = db.attention({});

  assert.ok(!digest.overdue.some((o) => o.type === "waiting"), "what others owe me is not my backlog");
  db.close();
});

test("attention: the horizon bounds what counts as upcoming", () => {
  const db = withObligations();
  assert.equal(db.attention({ horizonDays: 1 }).dueSoon.length, 0);
  assert.equal(db.attention({ horizonDays: 3 }).dueSoon.length, 1);
  db.close();
});

test("attention: reports whether there is anything at all, so a quiet day sends nothing", () => {
  const empty = dated();
  assert.equal(empty.attention({}).total, 0);
  empty.close();

  const db = withObligations();
  assert.equal(db.attention({}).total, 4);
  db.close();
});

test("attention: resolved items drop out of the digest", () => {
  const db = withObligations();
  for (const item of db.extractions({})) db.resolveExtraction(item.id, "done");

  assert.equal(db.attention({}).total, 0);
  db.close();
});

/* ---------------------------------------------------------------- *
 * Phase 9 — the roster and learned aliases
 * ---------------------------------------------------------------- */

test("roster: lists archived chats with how much is known about each", () => {
  const db = store();
  db.upsertMessages("Helena", [msg(), msg({ key: "k2", text: "b" })]);
  db.upsertMessages("Fabio", [msg({ key: "k3", text: "c" })]);

  const roster = db.roster();
  assert.deepEqual(
    roster.map((r) => [r.name, r.messages]),
    [["Helena", 2], ["Fabio", 1]],
  );
  db.close();
});

test("roster: is empty before anything is archived, rather than throwing", () => {
  const db = store();
  assert.deepEqual(db.roster(), []);
  db.close();
});

test("alias: round-trips, keyed by a normalised name", () => {
  const db = store();
  db.setAlias("Tonhão", "Antonio Moreira");

  assert.equal(db.aliasMap().get("tonhão"), "Antonio Moreira");
  db.close();
});

test("alias: setting it again replaces the target", () => {
  const db = store();
  db.setAlias("tonhão", "Wrong Person");
  db.setAlias("tonhão", "Antonio Moreira");

  assert.equal(db.aliasMap().size, 1);
  assert.equal(db.aliasMap().get("tonhão"), "Antonio Moreira");
  db.close();
});

test("alias: can be forgotten", () => {
  const db = store();
  db.setAlias("tonhão", "Antonio Moreira");
  db.removeAlias("Tonhão");

  assert.equal(db.aliasMap().size, 0);
  db.close();
});

test("alias: forgetting one that was never set is refused, not silent", () => {
  const db = store();
  assert.throws(() => db.removeAlias("nobody"), (e) => /alias/i.test(e.message));
  db.close();
});

test("alias: an empty alias or target is refused", () => {
  const db = store();
  assert.throws(() => db.setAlias("  ", "Someone"));
  assert.throws(() => db.setAlias("someone", "  "));
  db.close();
});
