import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { openStore, arcKeyFor } from "../src/store.js";
import { applyPhantomChatRepair, planPhantomChatRepair } from "../src/chat-repair.js";

/**
 * The archive after a display name was stored as a chat address.
 *
 * Two properties, and they are separate on purpose:
 *
 *   1. The store can no longer MINT a conversation from a name. That is the
 *      defect; everything else here is its consequence.
 *   2. The rows a previous version already minted can be folded back into the
 *      conversation they shadow, without forking a single arc.
 *
 * Both run against a real SQLite database with a real schema, because the
 * failure was in what the rows were, not in what the code intended.
 */

const NOW = "2026-08-12T09:00:00.000Z";
const ADDRESS = "120363000000000001@g.us";

/** A store with one addressed group in it, holding two real messages. */
function archive() {
  const store = openStore(":memory:", { dateOrder: "day-first", now: () => NOW });
  store.upsertTransportMessages([
    {
      key: "m1",
      chat: { key: ADDRESS, kind: "group", displayName: "Alpha + Pais" },
      sender: { key: "1@lid" },
      sentAtIso: "2026-08-12T08:00:00.000Z",
      kind: "text",
      text: "morning",
      outgoing: false,
    },
    {
      key: "m2",
      chat: { key: ADDRESS, kind: "group", displayName: "Alpha + Pais" },
      sender: { key: "1@lid" },
      sentAtIso: "2026-08-12T08:05:00.000Z",
      kind: "text",
      text: "all set",
      outgoing: false,
    },
  ]);
  return store;
}

const pass = (chat) => ({
  chat,
  throughMessageKey: "m2",
  considered: 2,
  arcs: [
    {
      title: "Saturday lunch",
      summary: "who is bringing what",
      firstMessageKey: "m1",
      lastMessageKey: "m2",
      goals: [{ holder: "user", statement: "not host it", sourceMessageKey: "m1" }],
    },
  ],
  contexts: [{ dimension: "language", statement: "pt-BR", sourceMessageKey: "m1" }],
});

/* ---------------------------------------------------------------- *
 * 1. The defect itself.
 * ---------------------------------------------------------------- */

test("a modelling pass cannot mint a conversation out of a display name", () => {
  const store = archive();
  const before = store.chats({ limit: 100 }).length;

  assert.throws(() => store.saveInteractionModel(pass("Alpha + Pais")), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /No conversation is archived under "Alpha \+ Pais"/);
    return true;
  });

  assert.equal(store.chats({ limit: 100 }).length, before, "no chat row may be created");
});

test("a proposal cannot mint a conversation out of a display name", () => {
  const store = archive();
  const before = store.chats({ limit: 100 }).length;

  assert.throws(
    () =>
      store.addProposals([
        { chat: "Alpha + Pais", kind: "reply", headline: "answer them", rationale: "they asked", basis: ["m1"] },
      ]),
    (error) => {
      assert.equal(error.statusCode, 409);
      return true;
    },
  );

  assert.equal(store.chats({ limit: 100 }).length, before);
});

test("a pass filed against the address is stored, and against the address only", () => {
  const store = archive();
  const result = store.saveInteractionModel(pass(ADDRESS));

  assert.equal(result.arcs.inserted, 1);
  const chats = store.chats({ limit: 100 });
  assert.equal(chats.length, 1);
  assert.equal(chats[0].key, ADDRESS);
  assert.equal(store.twin(ADDRESS).arcs.length, 1);
});

/* ---------------------------------------------------------------- *
 * 2. Repairing what the old code already wrote.
 * ---------------------------------------------------------------- */

/**
 * Re-create the corruption the way it actually happened: with the pre-fix code
 * path, which is now refused — so it is reproduced by inserting the phantom row
 * directly and modelling against it.
 */
function withPhantom(store, db) {
  db.prepare(
    `INSERT INTO chats (name, first_seen, last_seen, display_name) VALUES (?, ?, ?, NULL)`,
  ).run("Alpha + Pais", NOW, NOW);
  return store.saveInteractionModel(pass("Alpha + Pais"));
}

/** openStore, plus the raw handle the repair works through. */
function pair() {
  const path = `/tmp/wa-repair-${process.pid}-${Math.random().toString(36).slice(2)}.db`;
  const store = openStore(path, { dateOrder: "day-first", now: () => NOW });
  store.upsertTransportMessages([
    {
      key: "m1",
      chat: { key: ADDRESS, kind: "group", displayName: "Alpha + Pais" },
      sender: { key: "1@lid" },
      sentAtIso: "2026-08-12T08:00:00.000Z",
      kind: "text",
      text: "morning",
      outgoing: false,
    },
    {
      key: "m2",
      chat: { key: ADDRESS, kind: "group", displayName: "Alpha + Pais" },
      sender: { key: "1@lid" },
      sentAtIso: "2026-08-12T08:05:00.000Z",
      kind: "text",
      text: "all set",
      outgoing: false,
    },
  ]);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return { store, db, path };
}

test("the plan names every phantom, its home, and nothing else", () => {
  const { store, db } = pair();
  withPhantom(store, db);

  const plan = planPhantomChatRepair(db);

  assert.equal(plan.merges.length, 1);
  assert.equal(plan.merges[0].phantom.name, "Alpha + Pais");
  assert.equal(plan.merges[0].phantom.messages, 0);
  assert.equal(plan.merges[0].phantom.arcs, 1);
  assert.equal(plan.merges[0].into.name, ADDRESS);
  assert.equal(plan.merges[0].into.messages, 2);
  assert.equal(plan.orphans.length, 0);
  assert.equal(plan.legacy.length, 0);
});

test("repair moves the model onto the real chat and removes the phantom", () => {
  const { store, db } = pair();
  withPhantom(store, db);

  // Before: the model is on the phantom and the real chat has none.
  assert.equal(store.twin(ADDRESS).arcs.length, 0);

  const result = applyPhantomChatRepair(db);
  assert.equal(result.merged, 1);

  const twin = store.twin(ADDRESS);
  assert.equal(twin.arcs.length, 1);
  assert.equal(twin.arcs[0].title, "Saturday lunch");
  assert.equal(twin.arcs[0].goals.length, 1);
  assert.equal(twin.contexts.length, 1);
  assert.equal(
    db.prepare("SELECT modelled_at FROM twin_passes").get().modelled_at,
    NOW,
    "the pass record follows the model",
  );

  assert.equal(
    store.chats({ limit: 100 }).filter((c) => c.key === "Alpha + Pais").length,
    0,
    "the phantom is gone",
  );
});

test("repaired arcs are re-keyed, so the next pass continues them instead of forking", () => {
  const { store, db } = pair();
  withPhantom(store, db);
  applyPhantomChatRepair(db);

  const key = db.prepare("SELECT key FROM arcs").get().key;
  assert.equal(key, arcKeyFor(ADDRESS, "Saturday lunch"), "keyed by address, not by name");

  // The pass that would have run tomorrow, now correctly addressed.
  const again = store.saveInteractionModel(pass(ADDRESS));
  assert.equal(again.arcs.inserted, 0);
  assert.equal(again.arcs.updated, 1, "the arc is continued, not duplicated");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM arcs").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM goals").get().n, 1);
});

test("a phantom whose thread the real chat already models is folded, not duplicated", () => {
  const { store, db } = pair();
  withPhantom(store, db);
  // The same thread, modelled properly against the address as well.
  store.saveInteractionModel(pass(ADDRESS));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM arcs").get().n, 2);

  applyPhantomChatRepair(db);

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM arcs").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM goals").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contexts").get().n, 1);
});

test("a name-keyed chat that holds messages is reported and left alone", () => {
  const { store, db } = pair();
  // A conversation from before the transport: addressed by its rendered name.
  store.upsertMessages("Ana Fixture Silva", [
    { key: "d1", kind: "text", from: "Ana Fixture", time: "12/08/2026 08:00", text: "oi", outgoing: false },
  ]);

  const plan = planPhantomChatRepair(db);
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.legacy.length, 1);
  assert.equal(plan.legacy[0].name, "Ana Fixture Silva");

  applyPhantomChatRepair(db, plan);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM chats WHERE name = ?").get("Ana Fixture Silva").n,
    1,
    "a real conversation is never deleted by a repair",
  );
});

test("a phantom with no conversation to fold into is left alone and reported", () => {
  const { store, db } = pair();
  db.prepare(`INSERT INTO chats (name, first_seen, last_seen) VALUES (?, ?, ?)`).run(
    "Rowing Club",
    NOW,
    NOW,
  );

  const plan = planPhantomChatRepair(db);
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.orphans.length, 1);
  assert.equal(plan.orphans[0].name, "Rowing Club");

  applyPhantomChatRepair(db, plan);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chats WHERE name = ?").get("Rowing Club").n, 1);
  void store;
});
