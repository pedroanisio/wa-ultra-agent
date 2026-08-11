import { test } from "node:test";
import assert from "node:assert/strict";

import {
  diffRoster,
  eventKey,
  inQuietHours,
  parseQuietHours,
  planReactions,
} from "../src/watch.js";

/**
 * The watcher's rules, tested without a browser.
 *
 * Two properties matter more than the rest, and both are here because getting
 * them wrong is expensive rather than merely wrong:
 *
 *   - A filtered pane must never be diffed. Every read and every send filters
 *     it, so a bug here fires spurious events during normal operation — and with
 *     reactive top-up enabled, spurious events spend browser interactions.
 *   - The first snapshot must emit nothing. Otherwise restarting the bridge
 *     triggers one read per already-unread chat.
 */

const snap = (rows, over = {}) => ({
  rows,
  filtered: false,
  at: "2026-08-10T12:00:00.000Z",
  ...over,
});

const row = (over = {}) => ({ name: "Helena", preview: "oi", unread: 0, time: "14:30", ...over });

/* ---------------------------------------------------------------- *
 * Event identity
 * ---------------------------------------------------------------- */

test("key: identical observations collapse onto one event", () => {
  const observation = { chat: "Helena", kind: "message", preview: "oi", unread: 1, time: "14:30" };
  assert.equal(eventKey(observation), eventKey({ ...observation }));
});

test("key: a different preview is a different event", () => {
  const base = { chat: "Helena", kind: "message", preview: "oi", unread: 1, time: "14:30" };
  assert.notEqual(eventKey(base), eventKey({ ...base, preview: "tudo bem?" }));
});

/* ---------------------------------------------------------------- *
 * Diffing
 * ---------------------------------------------------------------- */

test("diff: the first snapshot establishes a baseline and emits nothing", () => {
  // A restart must not look like a hundred new messages.
  const result = diffRoster(null, snap([row({ unread: 4 }), row({ name: "Fabio", unread: 2 })]));

  assert.deepEqual(result.events, []);
  assert.equal(result.skipped, "no-baseline");
  assert.ok(result.baseline);
});

test("diff: a rising unread count is a message", () => {
  const { events } = diffRoster(snap([row({ unread: 0 })]), snap([row({ unread: 2, preview: "oi" })]));

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "message");
  assert.equal(events[0].chat, "Helena");
});

test("diff: a chat that was not there before, already unread, is a message", () => {
  const { events } = diffRoster(snap([]), snap([row({ unread: 1 })]));
  assert.deepEqual(events.map((e) => e.kind), ["message"]);
});

test("diff: a moved preview on an unread chat is a message even with a flat count", () => {
  // WhatsApp caps the badge, so a busy chat stops incrementing while messages
  // keep arriving. Requiring the count to rise would go deaf on exactly the
  // chats that matter most.
  const { events } = diffRoster(
    snap([row({ unread: 5, preview: "a" })]),
    snap([row({ unread: 5, preview: "b" })]),
  );

  assert.deepEqual(events.map((e) => e.kind), ["message"]);
});

test("diff: unread falling to zero is recorded as handled elsewhere", () => {
  const { events } = diffRoster(snap([row({ unread: 3 })]), snap([row({ unread: 0 })]));
  assert.deepEqual(events.map((e) => e.kind), ["unread-cleared"]);
});

test("diff: a preview moving with nothing unread is the user's own message", () => {
  const { events } = diffRoster(
    snap([row({ unread: 0, preview: "a" })]),
    snap([row({ unread: 0, preview: "b" })]),
  );

  assert.deepEqual(events.map((e) => e.kind), ["own-message"]);
});

test("diff: an unchanged pane emits nothing", () => {
  const { events } = diffRoster(snap([row({ unread: 2 })]), snap([row({ unread: 2 })]));
  assert.deepEqual(events, []);
});

test("diff: a vanished row is never an event", () => {
  // The pane is virtualised: absence means scrolled away or archived, not gone.
  const { events } = diffRoster(snap([row(), row({ name: "Fabio" })]), snap([row()]));
  assert.deepEqual(events, []);
});

test("diff: a filtered snapshot is neither diffed nor kept as a baseline", () => {
  // This is the load-bearing one. openChat types into the box that filters this
  // pane, so every read and every send produces a filtered snapshot.
  const previous = snap([row({ unread: 0 }), row({ name: "Fabio", unread: 0 })]);
  const result = diffRoster(previous, snap([row({ name: "Fabio", unread: 9 })], { filtered: true }));

  assert.deepEqual(result.events, []);
  assert.equal(result.skipped, "filtered");
  assert.equal(result.baseline, null, "a filtered snapshot must not become the next baseline");
});

test("diff: the snapshot after a filtered one only re-baselines", () => {
  const stale = snap([row()], { filtered: true });
  const result = diffRoster(stale, snap([row({ unread: 7 })]));

  assert.deepEqual(result.events, [], "cannot trust a diff against a filtered baseline");
  assert.equal(result.skipped, "stale-baseline");
  assert.ok(result.baseline);
});

/* ---------------------------------------------------------------- *
 * Quiet hours
 * ---------------------------------------------------------------- */

test("quiet: parses a window and rejects nonsense", () => {
  assert.deepEqual(parseQuietHours("23:00-07:00"), { from: 1380, to: 420 });
  assert.equal(parseQuietHours(""), null);
  assert.equal(parseQuietHours("always"), null);
  assert.equal(parseQuietHours("99:00-07:00"), null);
});

test("quiet: a window across midnight covers both sides of it", () => {
  const window = parseQuietHours("23:00-07:00");

  assert.equal(inQuietHours("2026-08-10T23:30:00.000Z", window), true);
  assert.equal(inQuietHours("2026-08-10T03:00:00.000Z", window), true);
  assert.equal(inQuietHours("2026-08-10T12:00:00.000Z", window), false);
  assert.equal(inQuietHours("2026-08-10T07:00:00.000Z", window), false, "end is exclusive");
});

test("quiet: no window configured is never quiet", () => {
  assert.equal(inQuietHours("2026-08-10T03:00:00.000Z", null), false);
});

/* ---------------------------------------------------------------- *
 * Reaction planning — the interaction budget's first line
 * ---------------------------------------------------------------- */

const event = (over = {}) => ({
  chat: "Helena",
  kind: "message",
  preview: "oi",
  unread: 1,
  observedAt: "2026-08-10T12:00:00.000Z",
  key: "k1",
  ...over,
});

const now = "2026-08-10T12:00:00.000Z";

test("plan: several messages in one chat are one read", () => {
  const plan = planReactions([event({ key: "a" }), event({ key: "b" }), event({ key: "c" })], { now });

  assert.equal(plan.read.length, 1);
  assert.equal(plan.read[0].chat, "Helena");
  assert.equal(plan.read[0].events.length, 3);
});

test("plan: an incoming event is notified even when its read is deferred", () => {
  // Deferring a read must never silently defer telling the user.
  const plan = planReactions([event()], {
    now,
    lastTouched: new Map([["Helena", "2026-08-10T11:59:00.000Z"]]),
  });

  assert.deepEqual(plan.read, [], "cooldown holds the read");
  assert.equal(plan.notify.length, 1, "but the user is still told");
});

test("plan: an informational event is neither read nor notified", () => {
  // "You read it on your phone" and "you sent this from your phone" are worth
  // recording and worth nobody's attention. They close out where they stand.
  const plan = planReactions([event({ kind: "unread-cleared" }), event({ kind: "own-message", key: "b" })], {
    now,
  });

  assert.deepEqual(plan.read, []);
  assert.deepEqual(plan.notify, []);
  assert.deepEqual(
    plan.archive.map((d) => d.why),
    ["unread-cleared-is-informational", "own-message-is-informational"],
  );
});

test("plan: a chat read moments ago is left alone", () => {
  const plan = planReactions([event()], {
    now,
    cooldownMs: 15 * 60_000,
    lastTouched: new Map([["Helena", "2026-08-10T11:55:00.000Z"]]),
  });

  assert.deepEqual(plan.read, []);
  assert.equal(plan.deferred[0].why, "cooldown");
});

test("plan: once the cooldown has passed the chat is readable again", () => {
  const plan = planReactions([event()], {
    now,
    cooldownMs: 15 * 60_000,
    lastTouched: new Map([["Helena", "2026-08-10T11:40:00.000Z"]]),
  });

  assert.equal(plan.read.length, 1);
});

test("plan: quiet hours spend no interactions at all, notification included", () => {
  // A self-note is still a browser interaction — it opens a chat and types — so
  // notifying during quiet hours would produce the exact activity signature the
  // window exists to avoid, and ring the user's phone at 04:00 as well.
  const plan = planReactions([event(), event({ chat: "Fabio", key: "b" })], {
    now: "2026-08-11T04:00:00.000Z",
    quietHours: parseQuietHours("23:00-07:00"),
  });

  assert.deepEqual(plan.read, []);
  assert.deepEqual(plan.notify, []);
  assert.equal(plan.reason, "quiet-hours");
  assert.equal(plan.deferred.length, 2, "held, not dropped");
});

test("plan: the batch is handled normally once the window closes", () => {
  const plan = planReactions([event()], {
    now: "2026-08-11T08:00:00.000Z",
    quietHours: parseQuietHours("23:00-07:00"),
  });

  assert.equal(plan.read.length, 1);
  assert.equal(plan.notify.length, 1);
  assert.equal(plan.reason, null);
});

test("plan: a backlog cannot become a sweep", () => {
  const events = ["a", "b", "c", "d", "e"].map((n) => event({ chat: n, key: n }));
  const plan = planReactions(events, { now, maxChatsPerWake: 3 });

  assert.equal(plan.read.length, 3);
  assert.equal(plan.deferred.length, 2);
  assert.ok(plan.deferred.every((d) => d.why === "fan-out-cap"));
});
