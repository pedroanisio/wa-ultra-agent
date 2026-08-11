import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDossier, resolvePerson, scoreCandidate } from "../src/people.js";

/**
 * Choosing who a name refers to, without asking WhatsApp.
 *
 * WhatsApp's own search ranks by recency, which is why searching "Helena
 * Braga" opens the group "We" — she is its most recent sender. That is the bug
 * `assertResolvedMatches` exists to catch, and this is the layer that stops it
 * happening in the first place: ranking here is by NAME SIMILARITY ONLY. How
 * recently a chat was active is never evidence about who was meant.
 *
 * The other rule: ambiguity is reported, never guessed. Two plausible matches
 * return both and resolve nothing.
 */

const roster = [
  { name: "Helena Braga Souto", kind: "contact", messages: 400 },
  { name: "Ana Paula", kind: "contact", messages: 120 },
  { name: "Ana Carolina", kind: "contact", messages: 30 },
  { name: "Fabio Menezes", kind: "contact", messages: 90 },
  { name: "We", kind: "group", messages: 5000 },
  { name: "Kiko, Tuca, Zé", kind: "group", messages: 800 },
];

const resolve = (query, options = {}) => resolvePerson(query, { roster, ...options });

/* ---------------------------------------------------------------- *
 * Exact and near-exact
 * ---------------------------------------------------------------- */

test("an exact name resolves outright", () => {
  const result = resolve("Fabio Menezes");
  assert.equal(result.exact, true);
  assert.equal(result.name, "Fabio Menezes");
});

test("case and spacing do not matter", () => {
  assert.equal(resolve("  fabio   menezes ").name, "Fabio Menezes");
});

test("a trailing parenthetical is ignored, so a self-chat title still matches", () => {
  const result = resolvePerson("Joao Vitor (You)", {
    roster: [{ name: "Joao Vitor", kind: "contact", messages: 10 }],
  });
  assert.equal(result.exact, true);
});

test("a group name with commas resolves like any other name", () => {
  assert.equal(resolve("Kiko, Tuca, Zé").name, "Kiko, Tuca, Zé");
});

/* ---------------------------------------------------------------- *
 * The bug this layer exists to prevent
 * ---------------------------------------------------------------- */

test("a person's name never resolves to an unrelated group, however busy it is", () => {
  const result = resolve("Helena Braga");

  assert.equal(result.name, "Helena Braga Souto");
  assert.ok(!result.candidates.some((c) => c.name === "We"), '"We" is not a match for "Helena Braga"');
});

test("activity is not evidence: a busier chat does not outrank a better name match", () => {
  const busy = [
    { name: "Fabio Menezes", kind: "contact", messages: 1 },
    { name: "Futebol", kind: "group", messages: 99_999 },
  ];
  assert.equal(resolvePerson("Fabio", { roster: busy }).name, "Fabio Menezes");
});

/* ---------------------------------------------------------------- *
 * Partial names
 * ---------------------------------------------------------------- */

test("a unique first name resolves, but not as an exact match", () => {
  const result = resolve("Fabio");

  assert.equal(result.name, "Fabio Menezes");
  assert.equal(result.exact, false, "the caller must know this was inferred");
});

test("all query words must appear: a subset of a longer name resolves", () => {
  assert.equal(resolve("Souto Helena").name, "Helena Braga Souto");
});

test("an ambiguous first name resolves nothing and returns both candidates", () => {
  const result = resolve("Ana");

  assert.equal(result.name, undefined);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.candidates.map((c) => c.name).sort(), ["Ana Carolina", "Ana Paula"]);
});

test("an unknown name resolves nothing and says so without candidates", () => {
  const result = resolve("Whoever");

  assert.equal(result.name, undefined);
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.candidates, []);
});

/* ---------------------------------------------------------------- *
 * Aliases
 * ---------------------------------------------------------------- */

test("an alias resolves to its canonical name, exactly", () => {
  const result = resolve("tonhão", {
    aliases: new Map([["tonhão", "Fabio Menezes"]]),
  });

  assert.equal(result.exact, true);
  assert.equal(result.name, "Fabio Menezes");
  assert.equal(result.via, "alias");
});

test("an alias beats an ambiguous partial match", () => {
  const result = resolve("Ana", { aliases: new Map([["ana", "Ana Paula"]]) });

  assert.equal(result.name, "Ana Paula");
  assert.equal(result.ambiguous, false);
});

test("an alias pointing at nobody in the roster resolves nothing", () => {
  const result = resolve("ghost", { aliases: new Map([["ghost", "Someone Gone"]]) });

  assert.equal(result.name, undefined);
  assert.match(result.reason, /roster|not found|no longer/i);
});

test("alias matching ignores case and spacing too", () => {
  const result = resolve("  TONHÃO ", { aliases: new Map([["tonhão", "Fabio Menezes"]]) });
  assert.equal(result.name, "Fabio Menezes");
});

/* ---------------------------------------------------------------- *
 * Scoring
 * ---------------------------------------------------------------- */

test("scoring: an exact match scores highest", () => {
  assert.equal(scoreCandidate("fabio menezes", "fabio menezes"), 1);
});

test("scoring: a prefix scores above a mid-name token", () => {
  assert.ok(scoreCandidate("fabio", "fabio menezes") > scoreCandidate("menezes", "fabio menezes"));
});

test("scoring: an unrelated name scores zero", () => {
  assert.equal(scoreCandidate("bicicleta", "fabio menezes"), 0);
});

test("scoring: a substring that is not a whole word does not match", () => {
  // "We" must not match "Wesley" — the same rule the allowlist enforces.
  assert.equal(scoreCandidate("we", "wesley powell"), 0);
});

/* ---------------------------------------------------------------- *
 * Shape
 * ---------------------------------------------------------------- */

test("candidates are ordered best first and carry why they matched", () => {
  const result = resolve("Ana");

  assert.ok(result.candidates[0].score >= result.candidates[1].score);
  assert.ok(result.candidates[0].why);
});

test("an empty query is refused rather than matching everything", () => {
  const result = resolve("   ");
  assert.equal(result.name, undefined);
  assert.deepEqual(result.candidates, []);
});

/* ---------------------------------------------------------------- *
 * The dossier — everything known about one person, in one answer.
 *
 * The spec asked for stable person ids from a contact roster. This transport
 * supplies neither, so the canonical chat name is the identity and the same
 * two rules apply: rank by name, and hand ambiguity back rather than picking.
 * ---------------------------------------------------------------- */

const fact = (statement) => ({ id: 1, statement, source_message_key: "k1", source_chat: "Fabio" });
const item = (type, statement) => ({ id: 1, type, statement, status: "open" });

test("dossier: an ambiguous name is returned as a question, never resolved", () => {
  const dossier = buildDossier(resolve("Ana"), { profile: { messages: 99 } });

  assert.equal(dossier.found, false);
  assert.equal(dossier.ambiguous, true);
  assert.ok(dossier.candidates.length > 1, "the user needs both options to choose between");
  // Nothing about the person leaks out of an unresolved lookup: reporting one
  // candidate's message count would be quietly answering for the wrong Ana.
  assert.equal(dossier.activity, undefined);
});

test("dossier: a name nothing matches says so, with its reason", () => {
  const dossier = buildDossier(resolve("Ninguém"));

  assert.equal(dossier.found, false);
  assert.equal(dossier.ambiguous, false);
  assert.match(dossier.reason, /Ninguém/);
});

test("dossier: the two directions of obligation stay apart", () => {
  const dossier = buildDossier(resolve("Fabio Menezes"), {
    obligations: [
      item("waiting", "Fabio owes the numbers"),
      item("commitment", "send Fabio the contract"),
      item("request", "review the deck"),
      item("deadline", "file by Friday"),
      item("question", "did you see the email?"),
    ],
  });

  assert.equal(dossier.found, true);
  // Merged, these read as one backlog of five failures — and the one item that
  // is somebody else's move disappears into it.
  assert.deepEqual(
    dossier.obligations.theyOweUser.map((i) => i.statement),
    ["Fabio owes the numbers"],
  );
  assert.deepEqual(dossier.obligations.userOwesThem.map((i) => i.type), [
    "commitment",
    "request",
    "deadline",
  ]);
  assert.deepEqual(
    dossier.obligations.unanswered.map((i) => i.statement),
    ["did you see the email?"],
  );
});

test("dossier: carries activity, aliases and remembered facts", () => {
  const dossier = buildDossier(resolve("Fabio Menezes"), {
    profile: { messages: 412, last_message_at: "2026-08-04T18:42:00.000Z" },
    aliases: ["fabinho"],
    facts: [fact("a filha se chama Alice")],
  });

  assert.equal(dossier.name, "Fabio Menezes");
  assert.equal(dossier.activity.messages, 412);
  assert.equal(dossier.activity.lastMessageAt, "2026-08-04T18:42:00.000Z");
  assert.deepEqual(dossier.aliases, ["fabinho"]);
  assert.equal(dossier.facts[0].statement, "a filha se chama Alice");
});

test("dossier: a person with nothing stored is found, not missing", () => {
  const dossier = buildDossier(resolve("Fabio Menezes"));

  assert.equal(dossier.found, true);
  assert.equal(dossier.activity.messages, 0);
  assert.deepEqual(dossier.facts, []);
  assert.deepEqual(dossier.obligations.theyOweUser, []);
});

test("dossier: a partial match reports that it was not exact", () => {
  const dossier = buildDossier(resolve("Fabio"));

  assert.equal(dossier.found, true);
  assert.equal(dossier.exact, false, "the caller must be able to say which chat it read");
  assert.equal(dossier.via, "partial");
});
