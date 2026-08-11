import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/store.js";
import { HABIT_SAMPLE_FLOOR, interactionMetrics } from "../src/twin.js";

/**
 * The interaction twin, in its two halves.
 *
 * The measured half is arithmetic over rows: it must be exactly right, and it
 * must refuse to describe a habit it has seen twice as a habit. The modelled
 * half is a model's reading, and the only thing standing between it and a
 * confident fiction is that every arc, goal, context and proposed move cites a
 * message that was actually read. Both properties are tested here against a
 * real SQLite database, in memory, with an injected clock.
 */

const NOW = "2026-08-10T12:00:00.000Z";
const store = () => openStore(":memory:", { dateOrder: "day-first", now: () => NOW });

/** A message at a given wall-clock time, in WhatsApp's day-first rendering. */
const msg = (key, time, over = {}) => ({
  key,
  kind: "text",
  from: over.outgoing ? "me" : "Helena",
  time,
  text: "ok",
  outgoing: false,
  ...over,
});

/* ---------------------------------------------------------------- *
 * The measured half
 * ---------------------------------------------------------------- */

test("metrics: an empty conversation measures nothing and claims nothing", () => {
  const metrics = interactionMetrics([], { nowIso: NOW });
  assert.equal(metrics.messages, 0);
  assert.equal(metrics.medianReplyMinutesUser, undefined);
  assert.equal(metrics.ballWith, undefined);
  assert.equal(metrics.habitsAreThin, true);
});

test("metrics: reply time is measured only across a change of speaker", () => {
  const db = store();
  db.upsertMessages("Helena", [
    msg("a", "10/08/2026 10:00", { outgoing: false }),
    // Two of hers in a row: one turn typed twice, not a reply to herself.
    msg("b", "10/08/2026 10:05", { outgoing: false }),
    msg("c", "10/08/2026 10:15", { outgoing: true }),
    msg("d", "10/08/2026 10:45", { outgoing: false }),
  ]);

  const metrics = interactionMetrics(db.messagesFor("Helena"), { nowIso: NOW });
  assert.equal(metrics.replySampleUser, 1);
  assert.equal(metrics.medianReplyMinutesUser, 10);
  assert.equal(metrics.replySampleThem, 1);
  assert.equal(metrics.medianReplyMinutesThem, 30);
});

test("metrics: a long gap makes the next message an opening, not a reply", () => {
  const db = store();
  db.upsertMessages("Helena", [
    msg("a", "08/08/2026 10:00", { outgoing: false }),
    // Two days later. Nobody is replying within 48 hours to a "bom dia".
    msg("b", "10/08/2026 09:00", { outgoing: true }),
  ]);

  const metrics = interactionMetrics(db.messagesFor("Helena"), { nowIso: NOW });
  assert.equal(metrics.replySampleUser, 0, "a two-day gap is not a reply time");
  assert.equal(metrics.initiationsUser, 1);
  assert.equal(metrics.initiationsThem, 1);
});

test("metrics: a handful of exchanges is reported as thin, not as a habit", () => {
  const db = store();
  const messages = [];
  for (let i = 0; i < 4; i++) {
    messages.push(msg(`t${i}a`, `0${i + 1}/08/2026 10:00`, { outgoing: false }));
    messages.push(msg(`t${i}b`, `0${i + 1}/08/2026 10:05`, { outgoing: true }));
  }
  db.upsertMessages("Helena", messages);

  const metrics = interactionMetrics(db.messagesFor("Helena"), { nowIso: NOW });
  assert.ok(metrics.replySampleUser < HABIT_SAMPLE_FLOOR);
  assert.equal(metrics.habitsAreThin, true);
});

test("metrics: who spoke last decides who owes the next message", () => {
  const db = store();
  db.upsertMessages("Helena", [
    msg("a", "08/08/2026 10:00", { outgoing: true }),
    msg("b", "08/08/2026 10:02", { outgoing: false }),
  ]);

  const metrics = interactionMetrics(db.messagesFor("Helena"), { nowIso: NOW });
  assert.equal(metrics.ballWith, "user", "she spoke last, so it is the user's move");
  assert.equal(metrics.silentDays, 2);
});

test("metrics: a message with an unreadable timestamp is counted but never ordered", () => {
  const db = store();
  db.upsertMessages("Helena", [
    msg("a", "10/08/2026 10:00", { outgoing: false }),
    msg("b", "ontem", { outgoing: true }),
  ]);

  const metrics = interactionMetrics(db.messagesFor("Helena"), { nowIso: NOW });
  assert.equal(metrics.messages, 2);
  assert.equal(metrics.timed, 1, "the unparseable row cannot be placed in a sequence");
});

/* ---------------------------------------------------------------- *
 * The modelled half — provenance
 * ---------------------------------------------------------------- */

const seeded = () => {
  const db = store();
  db.upsertMessages("Helena", [
    msg("m1", "01/08/2026 10:00", { outgoing: false, text: "conseguiu ver o orçamento?" }),
    msg("m2", "01/08/2026 10:30", { outgoing: true, text: "vejo hoje à noite" }),
    msg("m3", "05/08/2026 09:00", { outgoing: false, text: "e aí?" }),
  ]);
  return db;
};

const arc = (over = {}) => ({
  title: "o orçamento da reforma",
  summary: "she is waiting on a decision about the renovation quote",
  status: "open",
  firstMessageKey: "m1",
  lastMessageKey: "m3",
  confidence: 0.8,
  goals: [],
  ...over,
});

test("model: an arc citing a message nobody read is refused", () => {
  const db = seeded();
  assert.throws(
    () =>
      db.saveInteractionModel({
        chat: "Helena",
        throughMessageKey: "m3",
        arcs: [arc({ firstMessageKey: "invented" })],
      }),
    /No message with key "invented"/,
  );
  assert.equal(db.stats().arcs, 0, "the pass was rejected whole");
});

test("model: one bad goal rejects the entire pass", () => {
  const db = seeded();
  assert.throws(
    () =>
      db.saveInteractionModel({
        chat: "Helena",
        throughMessageKey: "m3",
        arcs: [
          arc(),
          arc({
            title: "another thread",
            goals: [{ holder: "them", statement: "wants an answer", sourceMessageKey: "nope" }],
          }),
        ],
      }),
    /nope/,
  );
  assert.equal(db.stats().arcs, 0);
  assert.equal(db.stats().goals, 0);
});

test("model: an invented holder or status is refused by name", () => {
  const db = seeded();
  assert.throws(
    () => db.saveInteractionModel({ chat: "Helena", throughMessageKey: "m3", arcs: [arc({ status: "closed" })] }),
    /Unknown arc status "closed"/,
  );
  assert.throws(
    () =>
      db.saveInteractionModel({
        chat: "Helena",
        throughMessageKey: "m3",
        arcs: [arc({ goals: [{ holder: "her", statement: "x", sourceMessageKey: "m1" }] })],
      }),
    /Unknown goal holder "her"/,
  );
});

test("model: re-modelling a reworded title updates the arc instead of forking it", () => {
  const db = seeded();
  db.saveInteractionModel({ chat: "Helena", throughMessageKey: "m2", arcs: [arc()] });
  db.saveInteractionModel({
    chat: "Helena",
    throughMessageKey: "m3",
    // Same thread, tidier wording, and a different closing message.
    arcs: [arc({ title: "O Orçamento da Reforma!", lastMessageKey: "m3", status: "stalled" })],
  });

  const twin = db.twin("Helena");
  assert.equal(twin.arcs.length, 1, "a rewording is not a second thread");
  assert.equal(twin.arcs[0].status, "stalled");
  assert.equal(twin.arcs[0].last_message_key, "m3");
});

test("model: goals travel with their arc and keep their side", () => {
  const db = seeded();
  db.saveInteractionModel({
    chat: "Helena",
    throughMessageKey: "m3",
    arcs: [
      arc({
        goals: [
          { holder: "them", statement: "quer uma resposta sobre o orçamento", sourceMessageKey: "m1" },
          { holder: "user", statement: "não quer fechar preço ainda", sourceMessageKey: "m2" },
        ],
      }),
    ],
  });

  const [thread] = db.twin("Helena").arcs;
  assert.deepEqual(
    thread.goals.map((g) => g.holder).sort(),
    ["them", "user"],
    "the two sides are stored as opposite goals of one arc",
  );
  assert.equal(thread.goals[0].source_text.length > 0, true, "each goal resolves to its message");
});

test("model: a context observation cites the message that shows it", () => {
  const db = seeded();
  db.saveInteractionModel({
    chat: "Helena",
    throughMessageKey: "m3",
    contexts: [{ dimension: "language", statement: "português", sourceMessageKey: "m1", confidence: 0.95 }],
  });

  const twin = db.twin("Helena");
  assert.equal(twin.contexts.length, 1);
  assert.equal(twin.contexts[0].dimension, "language");

  assert.throws(
    () =>
      db.saveInteractionModel({
        chat: "Helena",
        throughMessageKey: "m3",
        contexts: [{ dimension: "vibe", statement: "x", sourceMessageKey: "m1" }],
      }),
    /Unknown context dimension "vibe"/,
  );
});

/* ---------------------------------------------------------------- *
 * The taint mark — which side a claim was read off
 *
 * The injection boundary (SPEC §6.3) turns on this distinction. "She wants the
 * quote signed" read off her message is untrusted third-party text that a model
 * has restated in tidy English; the same sentence read off the user's own
 * message is not. An extraction pass does not launder the difference, so the
 * twin has to carry it all the way to whatever renders it.
 * ---------------------------------------------------------------- */

test("twin: a goal says which side's message it was read off", () => {
  const db = seeded();
  db.saveInteractionModel({
    chat: "Helena",
    throughMessageKey: "m3",
    arcs: [
      arc({
        goals: [
          // m1 and m3 are hers; m2 is the user's own.
          { holder: "them", statement: "wants the quote decided", sourceMessageKey: "m3" },
          { holder: "user", statement: "wants to look at it tonight", sourceMessageKey: "m2" },
        ],
      }),
    ],
  });

  const goals = db.twin("Helena").arcs[0].goals;
  const theirs = goals.find((g) => g.holder === "them");
  const mine = goals.find((g) => g.holder === "user");

  assert.equal(theirs.source_outgoing, 0, "read off her message — third-party content");
  assert.equal(mine.source_outgoing, 1, "read off the user's own message");
});

test("twin: a context says which side's message it was read off", () => {
  const db = seeded();
  db.saveInteractionModel({
    chat: "Helena",
    throughMessageKey: "m3",
    contexts: [
      { dimension: "language", statement: "português", sourceMessageKey: "m1" },
      { dimension: "register", statement: "informal", sourceMessageKey: "m2" },
    ],
  });

  const contexts = db.twin("Helena").contexts;
  const fromHer = contexts.find((c) => c.dimension === "language");
  const fromUser = contexts.find((c) => c.dimension === "register");

  assert.equal(fromHer.source_outgoing, 0);
  assert.equal(fromUser.source_outgoing, 1);
});

test("twin: the mark is resolved from the cited message, never stored twice", () => {
  // Storing the direction on `goals` as well would let the two disagree, and a
  // taint mark that can drift from its own citation is worse than none: it
  // would read as authoritative while being wrong.
  const db = seeded();
  db.saveInteractionModel({
    chat: "Helena",
    throughMessageKey: "m3",
    arcs: [arc({ goals: [{ holder: "them", statement: "x", sourceMessageKey: "m3" }] })],
  });

  const columns = db.twin("Helena").arcs[0].goals[0];
  assert.equal(columns.source_outgoing, 0);
  assert.equal(
    columns.source_message_key,
    "m3",
    "the citation is the only place the direction comes from",
  );
});

/* ---------------------------------------------------------------- *
 * Staleness — the honesty column
 * ---------------------------------------------------------------- */

test("twin: a conversation nobody modelled says so, rather than reading as empty", () => {
  const db = seeded();
  const twin = db.twin("Helena");
  assert.equal(twin.coverage.stale, true);
  assert.match(twin.coverage.reason, /never been modelled/);
});

test("twin: messages arriving after a pass are counted, not ignored", () => {
  const db = seeded();
  db.saveInteractionModel({ chat: "Helena", throughMessageKey: "m2", considered: 2, arcs: [arc({ lastMessageKey: "m2" })] });

  const twin = db.twin("Helena");
  assert.equal(twin.coverage.messagesSince, 1);
  assert.match(twin.coverage.reason, /1 message arrived after/);

  db.saveInteractionModel({ chat: "Helena", throughMessageKey: "m3", considered: 3, arcs: [arc()] });
  assert.equal(db.twin("Helena").coverage.stale, false);
});

test("twin: an unarchived conversation is not modelled into existence", () => {
  const twin = store().twin("Fabio");
  assert.equal(twin.found, false);
  assert.match(twin.reason, /never been modelled|has been archived/);
});

test("stale: never-modelled chats surface ahead of drifted ones", () => {
  const db = seeded();
  db.upsertMessages("Fabio", [msg("f1", "09/08/2026 08:00", { outgoing: false, from: "Fabio" })]);
  db.saveInteractionModel({ chat: "Helena", throughMessageKey: "m3", considered: 3, arcs: [arc()] });

  const stale = db.staleTwins();
  assert.deepEqual(
    stale.map((row) => row.chat),
    ["Fabio"],
    "Helena is modelled up to her last message and does not need another pass",
  );
  assert.equal(stale[0].neverModelled, true);
});

/* ---------------------------------------------------------------- *
 * Proposals — a move argued from nothing cannot be stored
 * ---------------------------------------------------------------- */

const modelled = () => {
  const db = seeded();
  db.saveInteractionModel({ chat: "Helena", throughMessageKey: "m3", considered: 3, arcs: [arc()] });
  return db;
};

const move = (over = {}) => ({
  chat: "Helena",
  arcTitle: "o orçamento da reforma",
  kind: "reply",
  headline: "answer her about the quote",
  draft: "vi o orçamento, te falo amanhã",
  rationale: "she asked on 1 Aug and followed up on 5 Aug; the user said he would look that night",
  basis: ["m1", "m3"],
  confidence: 0.7,
  ...over,
});

test("proposal: a move with no cited message is refused", () => {
  assert.throws(() => modelled().addProposals([move({ basis: [] })]), /must cite at least one message/);
});

test("proposal: a move citing a message nobody read is refused", () => {
  assert.throws(() => modelled().addProposals([move({ basis: ["m1", "ghost"] })]), /No message with key "ghost"/);
});

test("proposal: a move cannot attach itself to an arc that was never found", () => {
  assert.throws(
    () => modelled().addProposals([move({ arcTitle: "a thread nobody modelled" })]),
    /No arc titled "a thread nobody modelled" is modelled/,
  );
});

test("proposal: reasoning is mandatory, because a move nobody can review is not a proposal", () => {
  assert.throws(() => modelled().addProposals([move({ rationale: "  " })]), /stated reasoning/);
});

test("proposal: dismissal sticks, and a repeat is counted rather than resurrected", () => {
  const db = modelled();
  db.addProposals([move()]);

  const [proposed] = db.proposals({ chat: "Helena" });
  db.resolveProposal(proposed.id, "dismissed");

  const again = db.addProposals([move()]);
  assert.equal(again.inserted, 0);
  assert.equal(again.repeated, 1);

  assert.equal(db.proposals({ chat: "Helena", status: "open" }).length, 0, "no is remembered");
  const [dismissed] = db.proposals({ chat: "Helena", status: "dismissed" });
  assert.equal(dismissed.times_proposed, 2, "the agent can see it has already suggested this");
});

test("twin: open proposals and dismissed ones both travel with the twin", () => {
  const db = modelled();
  db.addProposals([move(), move({ kind: "wait", headline: "leave the price alone", draft: null })]);

  const twin = db.twin("Helena");
  assert.equal(twin.proposals.length, 2);
  assert.deepEqual(twin.proposals[0].basis, ["m1", "m3"], "the citation survives the round trip");
  assert.equal(twin.arcs[0].title, "o orçamento da reforma");
  assert.equal(twin.obligations.userOwesThem.length, 0);
});
