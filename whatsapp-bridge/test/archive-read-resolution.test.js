import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

/**
 * Reading a conversation by the name the agent was shown.
 *
 * ── The seam this covers ────────────────────────────────────────────────────
 * `chat-address.test.js` proves the resolution rules and `chat-repair.test.js`
 * proves the store refuses to mint a chat from a name. Neither would have caught
 * the bug as the user met it, because the bug was in the JOIN between them:
 * `archiveMessages` resolved a name, got nothing, and then queried the store
 * with the raw name anyway — `resolveArchiveChat(chat) ?? chat`. The store
 * matches chats on their ADDRESS, so that query could only ever return zero
 * rows, and zero rows is what the agent reported to the user as an empty group.
 *
 * So this drives the real function against a real database, through the same
 * store handle the HTTP routes use, and asserts on what comes back.
 */

// Set before whatsapp.js is imported: its store handle is memoised from the env.
process.env.WA_STORE_PATH = join(mkdtempSync(join(tmpdir(), "wa-read-")), "store.db");

const { archiveMessages, resolveArchiveChat, searchArchive, interactionTwin } = await import(
  "../src/whatsapp.js"
);
const { openStore } = await import("../src/store.js");

const ADDRESS = "120363000000000002@g.us";
const NAME = "Duo";

before(() => {
  const store = openStore(process.env.WA_STORE_PATH);
  store.upsertTransportMessages([
    {
      key: "m1",
      chat: { key: ADDRESS, kind: "group", displayName: NAME },
      sender: { key: "1@lid" },
      sentAtIso: "2026-08-12T08:00:00.000Z",
      kind: "text",
      text: "first",
      outgoing: false,
    },
    {
      key: "m2",
      chat: { key: ADDRESS, kind: "group", displayName: NAME },
      sender: { key: "1@lid" },
      sentAtIso: "2026-08-12T08:30:00.000Z",
      kind: "text",
      text: "second",
      outgoing: false,
    },
  ]);

  // The phantom, exactly as the twin used to mint it: keyed by the display name,
  // holding nothing. It is inserted directly because the code that wrote it no
  // longer exists — which is the point of `chat-repair.test.js`.
  const raw = new DatabaseSync(process.env.WA_STORE_PATH);
  raw.prepare("INSERT INTO chats (name, first_seen, last_seen) VALUES (?, ?, ?)").run(
    NAME,
    "2026-08-12T09:00:00.000Z",
    "2026-08-12T09:00:00.000Z",
  );
});

test("a group asked for by name returns its messages, not the phantom's silence", async () => {
  const result = await archiveMessages({ chat: NAME, limit: 25, newest: true });

  assert.equal(result.resolved, ADDRESS, "resolved to the address, never to the name");
  assert.equal(result.matched, "name");
  assert.equal(result.messages.length, 2);
});

test("a name that resolves to nothing is an error, never an empty conversation", async () => {
  await assert.rejects(
    () => archiveMessages({ chat: "Rowing Club", limit: 25, newest: true }),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.match(error.message, /did not resolve, NOT an empty conversation/);
      return true;
    },
  );
});

test("resolveArchiveChat prefers the address over the phantom that shadows it", () => {
  assert.equal(resolveArchiveChat(NAME), ADDRESS);
  assert.equal(resolveArchiveChat(ADDRESS), ADDRESS);
  assert.equal(resolveArchiveChat("Rowing Club"), null);
});

test("the search filter and the twin resolve the same way, or refuse the same way", () => {
  assert.equal(searchArchive({ query: "first", chat: NAME }).chat, ADDRESS);
  assert.equal(searchArchive({ query: "first", chat: NAME }).hits.length, 1);

  assert.equal(interactionTwin({ chat: NAME }).found, true);

  for (const call of [
    () => searchArchive({ query: "first", chat: "Rowing Club" }),
    () => interactionTwin({ chat: "Rowing Club" }),
  ]) {
    assert.throws(call, (error) => error.statusCode === 404);
  }
});

test("history backfill resolves the same way, so the phone is asked about a real chat", async () => {
  // Not a transport test: it asserts only that an unresolvable name is refused
  // here rather than forwarded as an address the phone cannot answer.
  const { transportHistory } = await import("../src/whatsapp.js");
  assert.throws(
    () => transportHistory({ chat: "Rowing Club", count: 50 }),
    (error) => error.statusCode === 404,
  );
});
