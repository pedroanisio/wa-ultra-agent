import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SCHEMA_VERSION, openStore } from "../src/store.js";

/**
 * Storing what the protocol transport delivers.
 *
 * ── The problem this file is about ──────────────────────────────────────────
 * The archive was built against WhatsApp Web's DOM, where a chat has no id and
 * the only handle on it is the name rendered in the sidebar. So `chats.name` is
 * the chat's address, and every query and every agent tool passes that one
 * string: `messagesFor(chat)`, `search({chat})`, `twin(chat)`, `touchChat(chat)`.
 *
 * The protocol gives something better — a stable per-person key — but it gives no
 * display name that is safe to key on: `pushName` is asserted by the sender's own
 * device and changes whenever they edit it. Two people can advertise the same one.
 *
 * The resolution kept here: the chat's ADDRESS is its identity key, and the push
 * name is stored beside it as a mutable label. `chats.name` stays unique, so one
 * string still addresses exactly one chat and nothing above the store had to
 * change. Human names reach the key through the alias layer, which already
 * exists for exactly this and already records provenance.
 *
 * Fixtures use non-digit LID stand-ins because `identity-guard.js` fails the
 * build on `\d{6,20}@lid` — see the note in transport.test.js.
 */

const now = () => "2026-08-11T12:00:00.000Z";
const store = () => openStore(":memory:", { now });

/** A row in the shape `toArchiveRow` produces. */
const row = (over = {}) => ({
  key: "3EB0FIXTURE01",
  chat: { key: "fixture-a@lid", kind: "lid", provisional: false, displayName: "Fixture Contact" },
  sender: { key: "fixture-a@lid", kind: "lid", provisional: false },
  sentAt: "2026-08-11T09:15:00Z",
  sentAtIso: "2026-08-11T09:15:00.000Z",
  kind: "text",
  text: "o azulejista confirmou quinta",
  outgoing: false,
  recognised: true,
  fromHistory: false,
  ...over,
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "wa-transport-"));
  test.after?.(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── The schema change ──────────────────────────────────────────────────────

test("schema: a chat carries its identity kind, provisional flag and display name", () => {
  const archive = openStore(":memory:", { now });
  const columns = archive.chatColumns();
  archive.close();

  for (const column of ["display_name", "identity_kind", "identity_provisional"]) {
    assert.ok(columns.includes(column), `chats.${column} exists`);
  }
});

test("schema: the version was bumped alongside the migration", () => {
  // The two must move together or an operator's archive on disk silently lacks
  // the columns while every :memory: test passes.
  assert.ok(SCHEMA_VERSION >= 2, "SCHEMA_VERSION must advance with the new columns");
});

test("schema: a pre-transport archive on disk gains the columns without losing chats", () => {
  // The case the in-memory tests cannot see: ALTER against a real file that was
  // created before these columns existed.
  const path = join(tempDir(), "legacy.db");
  const seed = openStore(path, { now });
  seed.upsertMessages("Helena Braga", [
    { key: "dom-1", kind: "text", from: "Helena", time: "01/08/2026 10:00", text: "oi", outgoing: false },
  ]);
  seed.close();

  const reopened = openStore(path, { now });
  assert.equal(reopened.stats().chats, 1, "the DOM-era chat survived");
  assert.equal(reopened.stats().messages, 1);

  // And a DOM-era chat is distinguishable from a transport-era one: it has no
  // identity kind, because it was addressed by a rendered name.
  const db = new DatabaseSync(path);
  const chat = db.prepare("SELECT name, identity_kind FROM chats WHERE name = ?").get("Helena Braga");
  db.close();
  assert.equal(chat.identity_kind, null, "a name-addressed chat is not labelled as identity-keyed");
  reopened.close();
});

// ── Writing transport rows ─────────────────────────────────────────────────

test("upsertTransportMessages: a chat is created against its identity key", () => {
  const archive = store();
  const outcome = archive.upsertTransportMessages([row()]);

  assert.equal(outcome.inserted, 1);
  assert.deepEqual(outcome.chats, ["fixture-a@lid"], "the key is the chat's address");

  const [message] = archive.messagesFor("fixture-a@lid");
  assert.equal(message.text, "o azulejista confirmou quinta");
  assert.equal(message.sent_at_iso, "2026-08-11T09:15:00.000Z");
  archive.close();
});

test("upsertTransportMessages: the push name is stored as a label, never as the key", () => {
  const archive = store();
  archive.upsertTransportMessages([row()]);

  const chat = archive.chatIdentity("fixture-a@lid");
  assert.equal(chat.display_name, "Fixture Contact");
  assert.equal(chat.identity_kind, "lid");
  assert.equal(chat.identity_provisional, 0);

  // Nothing addresses the chat by the display name — that would fork the moment
  // the sender edited it on their phone.
  assert.equal(archive.messagesFor("Fixture Contact").length, 0);
  archive.close();
});

test("upsertTransportMessages: a renamed contact updates the label and keeps one chat", () => {
  // pushName is mutable. If it were the address, this would silently create a
  // second chat and split the person's history in half.
  const archive = store();
  archive.upsertTransportMessages([row()]);
  archive.upsertTransportMessages([
    row({ key: "3EB0FIXTURE02", chat: { ...row().chat, displayName: "Fixture Contact A." } }),
  ]);

  assert.equal(archive.stats().chats, 1, "still one chat");
  assert.equal(archive.stats().messages, 2, "and both messages are in it");
  assert.equal(archive.chatIdentity("fixture-a@lid").display_name, "Fixture Contact A.");
  archive.close();
});

test("upsertTransportMessages: re-delivery is idempotent on the message key", () => {
  // The transport is at-least-once by design, so this is the normal case after a
  // restart, not an edge case.
  const archive = store();
  archive.upsertTransportMessages([row()]);
  const second = archive.upsertTransportMessages([row()]);

  assert.equal(second.inserted, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(archive.stats().messages, 1);
  archive.close();
});

test("upsertTransportMessages: a provisional chat is recorded as provisional", () => {
  // `pn:<digest>` means no LID is known yet. The row is honest about being a
  // placeholder identity rather than presenting itself as settled.
  const archive = store();
  archive.upsertTransportMessages([
    row({
      key: "3EB0FIXTURE03",
      chat: { key: "pn:9f2ac41b7e", kind: "phone", provisional: true, displayName: "Fabio" },
      sender: { key: "pn:9f2ac41b7e", kind: "phone", provisional: true },
    }),
  ]);

  const chat = archive.chatIdentity("pn:9f2ac41b7e");
  assert.equal(chat.identity_provisional, 1);
  assert.equal(chat.identity_kind, "phone");
  archive.close();
});

test("upsertTransportMessages: provisional chats are reportable, because they are unmerged", () => {
  // The transport cannot tell the archive that `pn:<digest>` and a LID are the
  // same person — the payload carries no link between them. So the archive holds
  // both and must be able to say so, rather than presenting a split history as
  // complete. Inventing the merge would be worse than admitting the gap.
  const archive = store();
  archive.upsertTransportMessages([
    row({ key: "a1", chat: { key: "pn:9f2ac41b7e", kind: "phone", provisional: true, displayName: "Fabio" } }),
    row({ key: "a2", chat: { key: "fixture-b@lid", kind: "lid", provisional: false, displayName: "Fixture Contact" } }),
  ]);

  const unsettled = archive.provisionalChats();
  assert.deepEqual(
    unsettled.map((c) => c.name),
    ["pn:9f2ac41b7e"],
    "only the unsettled identity is reported",
  );
  archive.close();
});

test("upsertTransportMessages: a group chat is keyed on the group, and its senders differ", () => {
  const archive = store();
  archive.upsertTransportMessages([
    row({
      key: "g1",
      chat: { key: "fixture-group@g.us", kind: "group", provisional: false, displayName: "Obra" },
      sender: { key: "fixture-a@lid", kind: "lid", provisional: false },
    }),
    row({
      key: "g2",
      chat: { key: "fixture-group@g.us", kind: "group", provisional: false, displayName: "Obra" },
      sender: { key: "fixture-b@lid", kind: "lid", provisional: false },
    }),
  ]);

  assert.equal(archive.stats().chats, 1);
  const senders = new Set(archive.messagesFor("fixture-group@g.us").map((m) => m.sender));
  assert.equal(senders.size, 2, "two participants are distinguishable inside one group");
  archive.close();
});

test("upsertTransportMessages: provenance still holds — a fact can cite a transport message", () => {
  // The archive's one non-negotiable property. If transport rows could not be
  // cited, every derived fact would have to come from the DOM path forever.
  const archive = store();
  archive.upsertTransportMessages([row()]);

  assert.doesNotThrow(() =>
    archive.addFact({
      subject: "Fixture Contact",
      statement: "the tiler confirmed Thursday",
      sourceMessageKey: "3EB0FIXTURE01",
      confidence: 0.9,
    }),
  );
  const [fact] = archive.factsWithSource({ subject: "Fixture Contact" });
  assert.equal(fact.source_text, "o azulejista confirmou quinta");
  archive.close();
});

test("upsertTransportMessages: a batch spanning several chats is written in one call", () => {
  // A drain is a queue read, not a chat read: one batch routinely covers every
  // conversation that was active while the archive was down.
  const archive = store();
  const outcome = archive.upsertTransportMessages([
    row({ key: "m1", chat: { key: "fixture-a@lid", kind: "lid", provisional: false, displayName: "Fixture Contact" } }),
    row({ key: "m2", chat: { key: "fixture-b@lid", kind: "lid", provisional: false, displayName: "Fabio" } }),
    row({ key: "m3", chat: { key: "fixture-a@lid", kind: "lid", provisional: false, displayName: "Fixture Contact" } }),
  ]);

  assert.equal(outcome.inserted, 3);
  assert.equal(archive.stats().chats, 2);
  assert.deepEqual(outcome.chats.sort(), ["fixture-a@lid", "fixture-b@lid"]);
  archive.close();
});

test("upsertTransportMessages: one bad row does not roll back the whole batch's chats", () => {
  // A batch is up to 1000 entries drained from a queue. Losing 999 good messages
  // because one was malformed would mean the queue never drains past it.
  const archive = store();
  const outcome = archive.upsertTransportMessages([
    row({ key: "ok-1" }),
    row({ key: "", chat: { key: "fixture-a@lid", kind: "lid", provisional: false } }),
    row({ key: "ok-2" }),
  ]);

  assert.equal(outcome.inserted, 2, "the writable rows were written");
  assert.equal(outcome.rejected, 1, "and the unwritable one is counted, not hidden");
  archive.close();
});

test("upsertTransportMessages: the full-text index covers transport rows", () => {
  // FTS is populated by a trigger on messages, so this should hold for free —
  // which is exactly why it is worth pinning. Search is how the agent reads.
  const archive = store();
  archive.upsertTransportMessages([row()]);

  const hits = archive.search("azulejista");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, "3EB0FIXTURE01");
  archive.close();
});
