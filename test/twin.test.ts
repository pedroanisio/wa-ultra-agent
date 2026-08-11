import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CONFIDENCE_FLOOR } from "../agent/lib/extraction.ts";
import {
  ARC_STATUSES,
  CONTEXT_DIMENSIONS,
  GOAL_HOLDERS,
  GOAL_STATUSES,
  MAX_ARCS,
  MAX_PROPOSALS,
  PROPOSAL_KINDS,
  commitmentRisk,
  normalizeArcTitle,
  normalizeModel,
  normalizeProposals,
} from "../agent/lib/twin.ts";

/**
 * The gate between a model's reading of a conversation and what the archive will
 * accept.
 *
 * Everything here is about refusing output, not producing it. A model asked for
 * the threads in a conversation will always find some; a model asked for the next
 * best move will always have one. What stops that becoming an archive full of
 * confident fiction is that every arc, goal, context and proposed move must cite
 * a message that was actually read, use a word the store knows, and clear a
 * confidence floor — and that a draft committing the user to money, a time or an
 * apology is marked as theirs to word whatever the model claimed.
 */

/* ---------------------------------------------------------------- *
 * Drift: the same vocabulary on both sides of the seam
 * ---------------------------------------------------------------- */

/**
 * These lists exist twice — here and in `whatsapp-bridge/src/store.js` — because
 * the bridge is a separate service and cannot be imported. That duplication is
 * the kind that rots silently: the store would start rejecting a status the
 * agent still emits, and the only symptom would be a modelling pass that quietly
 * writes nothing. So the copies are compared against the real source.
 */
const bridgeSource = readFileSync(
  new URL("../whatsapp-bridge/src/store.js", import.meta.url),
  "utf8",
);

function bridgeList(name: string): string[] {
  const match = bridgeSource.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(match, `${name} is not exported by the bridge's store.js`);
  return [...match[1].replace(/\/\/[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("drift: the twin's vocabularies match the store that has to accept them", () => {
  assert.deepEqual([...ARC_STATUSES], bridgeList("ARC_STATUSES"));
  assert.deepEqual([...GOAL_HOLDERS], bridgeList("GOAL_HOLDERS"));
  assert.deepEqual([...GOAL_STATUSES], bridgeList("GOAL_STATUSES"));
  assert.deepEqual([...CONTEXT_DIMENSIONS], bridgeList("CONTEXT_DIMENSIONS"));
  assert.deepEqual([...PROPOSAL_KINDS], bridgeList("PROPOSAL_KINDS"));
});

test("drift: arc identity is computed the same way on both sides", () => {
  // The store derives an arc's primary key from this. If the two normalisations
  // disagree, every re-modelling pass forks every thread.
  const cases = ["O Orçamento da Reforma!", "  the Q3   numbers ", "Saturday"];
  const bridgeNormalize = (title: string) =>
    String(title || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\b(the|a|an|o|a|os|as|um|uma)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  assert.ok(
    bridgeSource.includes("export function normalizeArcTitle"),
    "the bridge still owns the canonical implementation",
  );
  for (const title of cases) {
    assert.equal(normalizeArcTitle(title), bridgeNormalize(title));
  }
  assert.equal(normalizeArcTitle("O Orçamento da Reforma!"), "orcamento da reforma");
});

/* ---------------------------------------------------------------- *
 * Modelling: citation, vocabulary, identity, threshold
 * ---------------------------------------------------------------- */

const keys = new Set(["m1", "m2", "m3"]);

const arc = (over: Record<string, unknown> = {}) => ({
  title: "o orçamento da reforma",
  summary: "she is waiting on a decision",
  status: "open",
  firstMessageKey: "m1",
  lastMessageKey: "m3",
  confidence: 0.8,
  goals: [],
  ...over,
});

test("model: an empty reading is accepted as an empty reading", () => {
  const { arcs, contexts } = normalizeModel({ arcs: [], contexts: [] }, keys);
  assert.equal(arcs.length, 0);
  assert.equal(contexts.length, 0);
});

test("model: garbage in place of a result yields nothing rather than throwing", () => {
  assert.deepEqual(normalizeModel(null, keys).arcs, []);
  assert.deepEqual(normalizeModel({ arcs: "several" }, keys).arcs, []);
});

test("model: an arc is dropped when either end of its span was invented", () => {
  const first = normalizeModel({ arcs: [arc({ firstMessageKey: "nope" })] }, keys);
  assert.equal(first.arcs.length, 0);
  assert.equal(first.dropped.uncited, 1);

  // The closing end matters just as much: an arc is a span, and a span with one
  // invented end is not partially right.
  const last = normalizeModel({ arcs: [arc({ lastMessageKey: "nope" })] }, keys);
  assert.equal(last.arcs.length, 0);
  assert.equal(last.dropped.uncited, 1);
});

test("model: a status the store would reject is dropped here", () => {
  const { arcs, dropped } = normalizeModel({ arcs: [arc({ status: "closed" })] }, keys);
  assert.equal(arcs.length, 0);
  assert.equal(dropped.badVocabulary, 1);
});

test("model: a guess is dropped, and an unstated confidence counts as a guess", () => {
  assert.equal(normalizeModel({ arcs: [arc({ confidence: CONFIDENCE_FLOOR - 0.01 })] }, keys).arcs.length, 0);
  const { arcs, dropped } = normalizeModel({ arcs: [arc({ confidence: undefined })] }, keys);
  assert.equal(arcs.length, 0);
  assert.equal(dropped.lowConfidence, 2 - 1);
});

test("model: a bad goal costs its goal, not the arc it belongs to", () => {
  const { arcs, dropped } = normalizeModel(
    {
      arcs: [
        arc({
          goals: [
            { holder: "them", statement: "wants an answer", status: "open", confidence: 0.8, sourceMessageKey: "m1" },
            { holder: "them", statement: "invented", status: "open", confidence: 0.9, sourceMessageKey: "ghost" },
          ],
        }),
      ],
    },
    keys,
  );

  assert.equal(arcs.length, 1, "the arc survives");
  assert.equal(arcs[0].goals.length, 1);
  assert.equal(dropped.uncitedGoals, 1);
  assert.equal(dropped.uncited, 0, "an uncitable goal is not counted as an uncitable arc");
});

test("model: a rewording of a known thread continues it and keeps the stored title", () => {
  const { arcs } = normalizeModel(
    { arcs: [arc({ title: "O Orçamento da Reforma!" })] },
    keys,
    ["o orçamento da reforma"],
  );

  assert.equal(arcs.length, 1);
  assert.equal(arcs[0].title, "o orçamento da reforma", "the stored spelling wins, so the key stays put");
  assert.equal(arcs[0].continues, true);
});

test("model: an unrecognised thread is reported as new", () => {
  const { arcs } = normalizeModel({ arcs: [arc({ title: "something else" })] }, keys, ["o orçamento"]);
  assert.equal(arcs[0].continues, false);
});

test("model: the same thread twice in one pass is stored once", () => {
  const { arcs, dropped } = normalizeModel({ arcs: [arc(), arc({ title: "O ORÇAMENTO DA REFORMA" })] }, keys);
  assert.equal(arcs.length, 1);
  assert.equal(dropped.duplicate, 1);
});

test("model: a conversation cannot have thirty threads", () => {
  const many = Array.from({ length: MAX_ARCS + 3 }, (_, i) => arc({ title: `thread ${i}` }));
  const { arcs, dropped } = normalizeModel({ arcs: many }, keys);
  assert.equal(arcs.length, MAX_ARCS);
  assert.equal(dropped.overflow, 3);
});

test("model: a context observation must name a dimension the store knows", () => {
  const { contexts, dropped } = normalizeModel(
    {
      contexts: [
        { dimension: "language", statement: "português", confidence: 0.95, sourceMessageKey: "m1" },
        { dimension: "vibe", statement: "chill", confidence: 0.95, sourceMessageKey: "m1" },
        { dimension: "language", statement: "PORTUGUÊS", confidence: 0.9, sourceMessageKey: "m2" },
      ],
    },
    keys,
  );

  assert.equal(contexts.length, 1);
  assert.equal(dropped.badVocabulary, 1);
  assert.equal(dropped.duplicate, 1, "the same observation restated is not a second observation");
});

/* ---------------------------------------------------------------- *
 * Proposals: grounding, restraint, and the wording gate
 * ---------------------------------------------------------------- */

const twinKeys = new Set(["m1", "m2", "m3"]);
const arcTitles = ["o orçamento da reforma"];

const move = (over: Record<string, unknown> = {}) => ({
  kind: "reply",
  arcTitle: "o orçamento da reforma",
  headline: "answer her about the quote",
  draft: "vi, te falo à noite",
  rationale: "she asked on 1 Aug and followed up on 5 Aug",
  timing: "tonight",
  needsUserWording: false,
  confidence: 0.8,
  basis: ["m1", "m3"],
  ...over,
});

const propose = (moves: unknown[], over: Record<string, unknown> = {}) =>
  normalizeProposals({ moves }, { citableKeys: twinKeys, knownArcTitles: arcTitles, ...over });

test("proposal: no move is a valid answer, and stays a valid answer", () => {
  assert.equal(propose([]).moves.length, 0);
  assert.equal(normalizeProposals(null, { citableKeys: twinKeys }).moves.length, 0);
});

test("proposal: a move that cites nothing real is dropped", () => {
  assert.equal(propose([move({ basis: [] })]).dropped.uncited, 1);
  assert.equal(propose([move({ basis: ["ghost"] })]).dropped.uncited, 1);
});

test("proposal: invented citations are stripped, real ones kept", () => {
  const { moves } = propose([move({ basis: ["m1", "ghost", "m2"] })]);
  assert.deepEqual(moves[0].basis, ["m1", "m2"]);
});

test("proposal: reasoning is mandatory", () => {
  assert.equal(propose([move({ rationale: "" })]).dropped.empty, 1);
  assert.equal(propose([move({ headline: "   " })]).dropped.empty, 1);
});

test("proposal: a move about a thread nobody modelled is dropped, not silently detached", () => {
  const { moves, dropped } = propose([move({ arcTitle: "a thread nobody found" })]);
  assert.equal(moves.length, 0);
  assert.equal(dropped.unknownArc, 1);
});

test("proposal: an arc title is matched the way the store matches it", () => {
  const { moves } = propose([move({ arcTitle: "O Orçamento da Reforma!" })]);
  assert.equal(moves[0].arcTitle, "o orçamento da reforma");
});

test("proposal: waiting has no draft, because a draft is not waiting", () => {
  const { moves } = propose([move({ kind: "wait", draft: "vou esperar" })]);
  assert.equal(moves[0].draft, undefined);
});

test("proposal: a move with no message is nobody's to word", () => {
  // Observed live: a `wait` came back flagged as the user's to word, and the tool
  // then told the agent to put a decision to say nothing in the user's own chat.
  // The flag means "there is a message here and it is theirs to word"; a wait and
  // a question for the user carry no message.
  for (const kind of ["wait", "ask_user"]) {
    const { moves } = propose([move({ kind, draft: undefined })]);
    assert.equal(moves[0].needsUserWording, false, `${kind} has no message to word`);
    assert.equal(moves[0].wordingReason, undefined);
  }

  // A reply with nothing drafted still is: the message exists, it just has no words yet.
  const { moves } = propose([move({ kind: "reply", draft: undefined })]);
  assert.equal(moves[0].needsUserWording, true);
  assert.match(moves[0].wordingReason!, /no draft/);
});

test("proposal: a committing draft is the user's to word, whatever the model said", () => {
  const money = propose([move({ draft: "fecho por R$ 4.500", needsUserWording: false })]);
  assert.equal(money.moves[0].needsUserWording, true);
  assert.match(money.moves[0].wordingReason!, /money/);

  const time = propose([move({ draft: "te encontro amanhã às 14:00", needsUserWording: false })]);
  assert.equal(time.moves[0].needsUserWording, true);

  const sorry = propose([move({ draft: "desculpa a demora", needsUserWording: false })]);
  assert.equal(sorry.moves[0].needsUserWording, true);

  const promise = propose([move({ draft: "prometo que vejo isso", needsUserWording: false })]);
  assert.equal(promise.moves[0].needsUserWording, true);
});

test("proposal: the wording gate only ever tightens", () => {
  // An innocuous draft the model flagged anyway stays flagged.
  const { moves } = propose([move({ draft: "vi sim", needsUserWording: true })]);
  assert.equal(moves[0].needsUserWording, true);
  assert.equal(moves[0].wordingReason, undefined, "the model's own flag needs no explanation");
});

test("proposal: an ordinary draft is not swept up by the wording gate", () => {
  assert.equal(commitmentRisk("vi sim, era isso mesmo"), undefined);
  const { moves } = propose([move({ draft: "vi sim, era isso mesmo" })]);
  assert.equal(moves[0].needsUserWording, false);
});

test("proposal: a move the user already refused never comes back", () => {
  const dismissed = [
    { kind: "reply", arcTitle: "o orçamento da reforma", draft: "vi, te falo à noite", headline: "answer her" },
  ];
  const { moves, dropped } = propose([move()], { dismissed });
  assert.equal(moves.length, 0);
  assert.equal(dropped.alreadyDismissed, 1);
});

test("proposal: the cap keeps the most confident moves, not the last ones emitted", () => {
  const many = Array.from({ length: MAX_PROPOSALS + 2 }, (_, i) =>
    move({ headline: `move ${i}`, draft: `draft ${i}`, confidence: 0.5 + i / 100 }),
  );
  const { moves, dropped } = propose(many);

  assert.equal(moves.length, MAX_PROPOSALS);
  assert.equal(dropped.overflow, 2);
  assert.deepEqual(
    moves.map((m) => m.headline),
    ["move 6", "move 5", "move 4", "move 3", "move 2"],
  );
});

test("proposal: a guess is dropped rather than ranked last", () => {
  const { moves, dropped } = propose([move({ confidence: CONFIDENCE_FLOOR - 0.01 })]);
  assert.equal(moves.length, 0);
  assert.equal(dropped.lowConfidence, 1);
});

test("proposal: an unknown kind is refused", () => {
  assert.equal(propose([move({ kind: "nudge" })]).dropped.badVocabulary, 1);
});
