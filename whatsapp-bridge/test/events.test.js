import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/store.js";
import { parseQuietHours, reactWith } from "../src/watch.js";

/**
 * The event queue's contract.
 *
 * The lease is the part worth testing hard. A dispatcher runs on a cadence, so
 * two ticks can overlap; if both could claim the same event, one arriving
 * message would produce two notifications, and a queue that cries wolf is a
 * queue the user turns off.
 *
 * A settable clock is what makes lease expiry testable without sleeping.
 */

function storeAt(clock) {
  return openStore(":memory:", { now: () => clock.value });
}

const clockFrom = (iso) => ({
  value: iso,
  advance(ms) {
    this.value = new Date(Date.parse(this.value) + ms).toISOString();
  },
});

const event = (over = {}) => ({
  key: "e1",
  chat: "Helena",
  kind: "message",
  preview: "oi",
  unread: 1,
  observedAt: "2026-08-10T12:00:00.000Z",
  ...over,
});

/* ---------------------------------------------------------------- *
 * Recording
 * ---------------------------------------------------------------- */

test("record: writes events and reports what it wrote", () => {
  const db = storeAt(clockFrom("2026-08-10T12:00:00.000Z"));
  const result = db.recordEvents([event(), event({ key: "e2", chat: "Fabio" })]);

  assert.equal(result.inserted, 2);
  assert.equal(result.duplicates, 0);
});

test("record: the same observation twice is one event", () => {
  // The observer debounces but is not guaranteed to fire once, and a reconnect
  // replays a snapshot. Dedup has to be the store's property, not the caller's.
  const db = storeAt(clockFrom("2026-08-10T12:00:00.000Z"));
  db.recordEvents([event()]);
  const again = db.recordEvents([event()]);

  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(db.eventStats().pending, 1);
});

test("record: an event may name a chat that was never archived", () => {
  // The whole point of an event is that it can be the first thing we know about
  // a conversation, so there is no foreign key onto chats here.
  const db = storeAt(clockFrom("2026-08-10T12:00:00.000Z"));
  assert.equal(db.recordEvents([event({ chat: "Someone Never Read" })]).inserted, 1);
});

/* ---------------------------------------------------------------- *
 * Claiming
 * ---------------------------------------------------------------- */

test("claim: takes pending events oldest first and leases them", () => {
  const db = storeAt(clockFrom("2026-08-10T12:00:00.000Z"));
  db.recordEvents([event({ key: "a" }), event({ key: "b" }), event({ key: "c" })]);

  const claimed = db.claimEvents({ limit: 2 });

  assert.deepEqual(claimed.map((e) => e.key), ["a", "b"]);
  assert.ok(claimed.every((e) => e.lease_until));
  assert.ok(claimed.every((e) => e.attempts === 1));
});

test("claim: a second overlapping claim cannot take the same event", () => {
  const db = storeAt(clockFrom("2026-08-10T12:00:00.000Z"));
  db.recordEvents([event({ key: "a" }), event({ key: "b" })]);

  const first = db.claimEvents({ limit: 10 });
  const second = db.claimEvents({ limit: 10 });

  assert.deepEqual(first.map((e) => e.key), ["a", "b"]);
  assert.deepEqual(second, [], "the lease has to exclude them");
});

test("claim: an expired lease is reclaimable", () => {
  // A claim that died with its process must come back, not be stranded.
  const clock = clockFrom("2026-08-10T12:00:00.000Z");
  const db = storeAt(clock);
  db.recordEvents([event({ key: "a" })]);

  db.claimEvents({ leaseForMs: 60_000 });
  clock.advance(61_000);
  const again = db.claimEvents({});

  assert.deepEqual(again.map((e) => e.key), ["a"]);
  assert.equal(again[0].attempts, 2, "attempts is what surfaces an event that keeps failing");
});

test("claim: a handled event is never claimed again", () => {
  const clock = clockFrom("2026-08-10T12:00:00.000Z");
  const db = storeAt(clock);
  db.recordEvents([event({ key: "a" })]);

  db.claimEvents({ leaseForMs: 60_000 });
  db.completeEvents(["a"]);
  clock.advance(10 * 60_000);

  assert.deepEqual(db.claimEvents({}), []);
});

/* ---------------------------------------------------------------- *
 * Completing and releasing
 * ---------------------------------------------------------------- */

test("complete: closes events out and is idempotent", () => {
  const db = storeAt(clockFrom("2026-08-10T12:00:00.000Z"));
  db.recordEvents([event({ key: "a" })]);
  db.claimEvents({});

  assert.equal(db.completeEvents(["a"]).handled, 1);
  assert.equal(db.completeEvents(["a"]).handled, 0, "a repeat is not an error");
  assert.equal(db.completeEvents(["never-seen"]).handled, 0);
  assert.equal(db.eventStats().pending, 0);
});

test("release: hands an event back for the next tick", () => {
  // Deferral is the normal path — cooldown, quiet hours, the fan-out cap — so
  // releasing must leave the event immediately claimable again.
  const db = storeAt(clockFrom("2026-08-10T12:00:00.000Z"));
  db.recordEvents([event({ key: "a" })]);
  db.claimEvents({ leaseForMs: 10 * 60_000 });

  assert.equal(db.releaseEvents(["a"]).released, 1);
  assert.deepEqual(db.claimEvents({}).map((e) => e.key), ["a"]);
});

test("release: refuses to resurrect a handled event", () => {
  const db = storeAt(clockFrom("2026-08-10T12:00:00.000Z"));
  db.recordEvents([event({ key: "a" })]);
  db.claimEvents({});
  db.completeEvents(["a"]);

  assert.equal(db.releaseEvents(["a"]).released, 0);
});

/* ---------------------------------------------------------------- *
 * Cooldown bookkeeping
 * ---------------------------------------------------------------- */

test("touch: records when a chat last cost an interaction", () => {
  const clock = clockFrom("2026-08-10T12:00:00.000Z");
  const db = storeAt(clock);

  db.touchChat("Helena", "event-top-up");
  assert.equal(db.lastTouched().get("Helena"), "2026-08-10T12:00:00.000Z");

  clock.advance(60_000);
  db.touchChat("Helena");
  assert.equal(db.lastTouched().get("Helena"), "2026-08-10T12:01:00.000Z", "latest wins");
});

test("touch: is independent of what the archive knows", () => {
  // chats.last_seen tracks the archive; this tracks the account's behaviour.
  // Conflating them would let an archive write reset a cooldown that exists to
  // keep the session from looking automated.
  const db = storeAt(clockFrom("2026-08-10T12:00:00.000Z"));
  db.upsertMessages("Helena", [
    { key: "m1", kind: "text", from: "Helena", time: "10/08/2026 14:30", text: "oi", outgoing: false },
  ]);

  assert.equal(db.lastTouched().has("Helena"), false);
});

/* ---------------------------------------------------------------- *
 * The whole reaction, browser injected
 *
 * Against a real in-memory store, with `ingest` recording what it was asked to
 * open. This is where the property that matters is checked: an event may cause
 * a bounded number of chat reads, and every claimed event still produces a
 * notification whether or not its chat was read.
 * ---------------------------------------------------------------- */

function harness(clock, { failOn = null } = {}) {
  const db = storeAt(clock);
  const opened = [];

  const ingest = async ({ chat, mode, maxScrolls }) => {
    opened.push({ chat, mode, maxScrolls });
    if (failOn === chat) throw new Error("chat did not open");
    return { inserted: 2, scanned: 5 };
  };

  return { db, opened, react: (options) => reactWith({ store: db, ingest, now: () => clock.value }, options) };
}

const settings = {
  cooldownMs: 15 * 60_000,
  maxChatsPerWake: 3,
  maxScrolls: 2,
  quietHours: null,
  quietHoursRaw: "",
};

test("react: an empty queue reads nothing", async () => {
  const { react, opened } = harness(clockFrom("2026-08-10T12:00:00.000Z"));
  const result = await react({ settings });

  assert.deepEqual(result.events, []);
  assert.deepEqual(opened, []);
  assert.match(result.note, /No pending events/);
});

test("react: tops up the chat an event names, and reports it", async () => {
  const { db, react, opened } = harness(clockFrom("2026-08-10T12:00:00.000Z"));
  db.recordEvents([event({ key: "a" })]);

  const result = await react({ settings });

  assert.deepEqual(opened, [{ chat: "Helena", mode: "top-up", maxScrolls: 2 }]);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.read, [{ chat: "Helena", inserted: 2, scanned: 5 }]);
});

test("react: ten messages in one chat cost one read", async () => {
  const clock = clockFrom("2026-08-10T12:00:00.000Z");
  const { db, react, opened } = harness(clock);
  db.recordEvents(
    Array.from({ length: 10 }, (_, i) => event({ key: `k${i}`, preview: `msg ${i}` })),
  );

  const result = await react({ settings });

  assert.equal(opened.length, 1, "coalesced");
  assert.equal(result.events.length, 10, "but all ten are reported");
});

test("react: the fan-out cap bounds reads and defers the rest", async () => {
  const { db, react, opened } = harness(clockFrom("2026-08-10T12:00:00.000Z"));
  db.recordEvents(["a", "b", "c", "d", "e"].map((n) => event({ key: n, chat: n })));

  const result = await react({ settings: { ...settings, maxChatsPerWake: 2 } });

  assert.equal(opened.length, 2);
  assert.equal(result.events.length, 5, "every arrival is still reported");
  assert.deepEqual(result.deferredWhy, ["fan-out-cap"]);
});

test("react: a chat inside its cooldown is reported but not reopened", async () => {
  const clock = clockFrom("2026-08-10T12:00:00.000Z");
  const { db, react, opened } = harness(clock);
  db.touchChat("Helena", "event-top-up");

  clock.advance(60_000);
  db.recordEvents([event({ key: "a" })]);
  const result = await react({ settings });

  assert.deepEqual(opened, [], "cooldown holds the read");
  assert.equal(result.events.length, 1, "the user is still told");
  assert.deepEqual(result.deferredWhy, ["cooldown"]);
});

test("react: quiet hours claim nothing at all", async () => {
  const clock = clockFrom("2026-08-11T04:00:00.000Z");
  const { db, react, opened } = harness(clock);
  db.recordEvents([event({ key: "a" })]);

  const result = await react({
    settings: { ...settings, quietHours: parseQuietHours("23:00-07:00"), quietHoursRaw: "23:00-07:00" },
  });

  assert.equal(result.quiet, true);
  assert.deepEqual(opened, []);
  assert.deepEqual(result.events, []);
  // Untouched, not leased: the next tick after the window closes must find it.
  assert.equal(db.eventStats().leased, 0);
  assert.equal(db.eventStats().pending, 1);
});

test("react: a misconfigured quiet window refuses rather than ignoring the limit", async () => {
  const { db, react } = harness(clockFrom("2026-08-10T12:00:00.000Z"));
  db.recordEvents([event({ key: "a" })]);

  await assert.rejects(
    () => react({ settings: { ...settings, quietHours: null, quietHoursRaw: "overnight" } }),
    /not a HH:MM-HH:MM window/,
  );
});

test("react: a failed top-up still reports the arrival", async () => {
  // Losing the notification because a chat would not open is the worst
  // available outcome: the user is told nothing and has no way to know.
  const clock = clockFrom("2026-08-10T12:00:00.000Z");
  const { db, react } = harness(clock, { failOn: "Helena" });
  db.recordEvents([event({ key: "a" })]);

  const result = await react({ settings });

  assert.equal(result.events.length, 1);
  assert.match(result.read[0].error, /did not open/);
  assert.ok(db.lastTouched().has("Helena"), "a failed attempt still starts a cooldown");
});

test("react: informational changes are closed out and reported to nobody", async () => {
  const { db, react, opened } = harness(clockFrom("2026-08-10T12:00:00.000Z"));
  db.recordEvents([
    event({ key: "a", kind: "unread-cleared" }),
    event({ key: "b", kind: "own-message" }),
  ]);

  const result = await react({ settings });

  assert.deepEqual(opened, []);
  assert.deepEqual(result.events, []);
  assert.equal(db.eventStats().pending, 0, "closed out, not left to be reconsidered forever");
});

test("react: claimed events stay pending until the caller acks them", async () => {
  // The ack is what survives a crash between reading and telling the user.
  const { db, react } = harness(clockFrom("2026-08-10T12:00:00.000Z"));
  db.recordEvents([event({ key: "a" })]);

  const result = await react({ settings });
  assert.equal(db.eventStats().pending, 1, "not completed by reacting");

  db.completeEvents(result.events.map((e) => e.key));
  assert.equal(db.eventStats().pending, 0);
});

test("react: a deferred-only batch releases its leases for the next tick", async () => {
  const clock = clockFrom("2026-08-10T12:00:00.000Z");
  const { db, react } = harness(clock);
  db.recordEvents([event({ key: "a", kind: "own-message" }), event({ key: "b", kind: "unread-cleared" })]);

  await react({ settings });
  assert.deepEqual(db.claimEvents({}), [], "all informational, all closed");
});

test("stats: reports pending, leased and handled separately", () => {
  const db = storeAt(clockFrom("2026-08-10T12:00:00.000Z"));
  db.recordEvents([event({ key: "a" }), event({ key: "b" }), event({ key: "c" })]);
  db.claimEvents({ limit: 2 });
  db.completeEvents(["a"]);

  assert.deepEqual(db.eventStats(), { pending: 2, handled: 1, leased: 1 });
});
