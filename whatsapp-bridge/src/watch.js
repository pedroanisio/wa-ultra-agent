import { createHash } from "node:crypto";

/**
 * Turning the open session into an event source.
 *
 * ── Why this can exist at all ───────────────────────────────────────────────
 * SPEC §0.1 says "no webhooks, no push — every observation is a poll". That is
 * true of the WhatsApp *transport*: there is no callback to register. It is not
 * true of the browser this bridge already holds open. `#pane-side` mutates in
 * the local DOM the instant a message lands in any chat, and reading a mutation
 * that has already happened costs no clicks, no typing and no navigation.
 *
 * That distinction is the whole design. What gets an account banned is the
 * *action* pattern — typing, opening, scrolling on a machine cadence. Passive
 * observation of a DOM we are already rendering is free on that axis, so
 * detection is not rationed here. Only *reacting* is, and that is what
 * `planReactions` exists to bound.
 *
 * ── Why the rules live in this file ─────────────────────────────────────────
 * Same split as message-kind.js, history.js and ingest.js: the browser produces
 * a plain description and decides nothing; what a change *means* is settled in
 * Node where it can be tested without a WhatsApp session. Every function here
 * is pure.
 */

/**
 * One chat-list row, as the observer reports it.
 *
 * @typedef  {object} Row
 * @property {string} name
 * @property {string} preview   The row's message snippet, sender prefix included.
 * @property {number} unread
 * @property {string} [time]
 */

/**
 * A snapshot of the pane, plus whether it can be trusted as a whole.
 *
 * `filtered` is not a detail. `openChat` types into the same search box that
 * filters this pane, so during any read or send the pane shows *matches only* —
 * and a filtered snapshot diffed against a full one reports every chat that was
 * merely hidden as though something had changed. See `diffRoster`.
 *
 * @typedef  {object} Snapshot
 * @property {Row[]}  rows
 * @property {boolean} filtered
 * @property {string}  at        ISO timestamp.
 */

/** Events that describe an incoming message, and so may cost an interaction. */
const INCOMING = new Set(["message", "mention"]);

/**
 * Content-addressed event identity.
 *
 * Same discipline as `messages.key`: the id is derived from what was observed,
 * never from a counter or a clock. Two observers seeing the same row state
 * produce the same key, so the debounce firing twice, a reconnect replaying a
 * snapshot, and a dispatcher retrying a claim all collapse onto one row in the
 * queue rather than waking the agent three times for one message.
 */
export function eventKey({ chat, kind, preview, unread, time }) {
  return createHash("sha256")
    .update([chat, kind, preview ?? "", String(unread ?? ""), time ?? ""].join("|"))
    .digest("hex")
    .slice(0, 16);
}

const byName = (rows) => new Map(rows.map((r) => [r.name, r]));

/**
 * What changed between two snapshots of the chat list.
 *
 * Returns `{ events, baseline }`. `baseline` is the snapshot the caller should
 * remember; it is `null` when this snapshot must not become one, which is the
 * mechanism that keeps a filtered pane from poisoning the next diff.
 *
 * Three cases produce no events on purpose:
 *
 *   - **No previous snapshot.** The first observation establishes a baseline and
 *     emits nothing. Emitting would fire one event per already-unread chat at
 *     every boot — with reactive top-up enabled that is a burst of unattended
 *     browser work triggered by a restart, which is exactly the machine-looking
 *     pattern this system is trying not to exhibit.
 *
 *   - **Either side filtered.** Not comparable. The events would be fiction.
 *
 *   - **A row that vanished.** The pane is virtualised and archiving or scrolling
 *     removes rows, so absence is never evidence of anything. Nothing is emitted
 *     and nothing is inferred.
 */
export function diffRoster(previous, current) {
  if (current.filtered) {
    // Do not diff it and do not keep it. The next full snapshot diffs against
    // the last full one, so a read that filtered the pane is simply invisible
    // here rather than being reported as a hundred changes.
    return { events: [], baseline: null, skipped: "filtered" };
  }
  if (!previous) return { events: [], baseline: current, skipped: "no-baseline" };
  if (previous.filtered) return { events: [], baseline: current, skipped: "stale-baseline" };

  const before = byName(previous.rows);
  const events = [];

  for (const row of current.rows) {
    const was = before.get(row.name);
    const unread = row.unread ?? 0;
    const previousUnread = was?.unread ?? 0;
    const previewChanged = !was || row.preview !== was.preview;

    let kind = null;
    if (unread > previousUnread) {
      // The unambiguous case: something arrived and nobody has read it.
      kind = "message";
    } else if (unread > 0 && previewChanged) {
      // The count can stay flat while the preview moves on — WhatsApp caps the
      // badge, and a chat already unread does not always increment. A changed
      // preview on an unread chat is still a new message.
      kind = "message";
    } else if (previousUnread > 0 && unread === 0) {
      // Read somewhere else, most likely on the phone. Worth recording — it is
      // the cheapest possible signal that a human already handled this — but it
      // is not an arrival, so it must never trigger a read of its own.
      kind = "unread-cleared";
    } else if (previewChanged && unread === 0 && was) {
      // Preview moved with nothing unread: the user sent this from their phone.
      // Recorded because a commitment the user made away from the keyboard is
      // exactly what extraction should see, and never acted on automatically.
      kind = "own-message";
    }

    if (!kind) continue;

    const event = {
      chat: row.name,
      kind,
      preview: row.preview ?? "",
      unread,
      time: row.time,
      observedAt: current.at,
    };
    events.push({ ...event, key: eventKey(event) });
  }

  return { events, baseline: current };
}

/**
 * Parse "23:00-07:00" into a comparable window. Returns null when unset or
 * unparseable — an unreadable setting must not silently mean "no quiet hours",
 * so callers treat null as absent and say so.
 */
export function parseQuietHours(raw) {
  const match = String(raw || "").match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const [, fromHour, fromMinute, toHour, toMinute] = match;
  const from = +fromHour * 60 + +fromMinute;
  const to = +toHour * 60 + +toMinute;
  if (from > 1439 || to > 1439) return null;
  return { from, to };
}

/**
 * Is `iso` inside the window? Wraps midnight, which is the normal case: the
 * hours worth silencing are the ones that straddle it.
 */
export function inQuietHours(iso, window) {
  if (!window) return false;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return false;

  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  return window.from <= window.to
    ? minutes >= window.from && minutes < window.to
    : minutes >= window.from || minutes < window.to;
}

/**
 * Which pending events are worth spending browser interactions on, right now.
 *
 * This function is the ban-risk mitigation. Reacting to an event means opening a
 * chat unattended, which is the thing README and SPEC previously refused to do
 * at all; the operator has chosen to allow it, so the limit has to be enforced
 * in code rather than asserted in a document an agent can talk itself out of.
 *
 * Four bounds, and each answers a specific way this could look automated:
 *
 *   - **Coalescing.** Ten messages in one chat are one read, not ten. Without
 *     this a busy group produces a read per message, which is both wasteful and
 *     the most obviously robotic pattern available.
 *   - **Per-chat cooldown.** A chat read a moment ago is not read again, however
 *     much arrives. An active conversation would otherwise hold the session in a
 *     continuous open-read loop for as long as someone keeps typing.
 *   - **Quiet hours.** Activity at 04:00 is a fingerprint no explanation fixes.
 *     Events accumulate and are handled when the window closes.
 *   - **Fan-out cap.** A backlog cannot become a sweep of thirty chats in one
 *     wake, which is a backfill wearing an event's clothes.
 *
 * Deferred events are *not* dropped: they stay pending and are reconsidered on
 * the next wake. Everything here is a decision about *when*, never about
 * whether the user gets told.
 */
export function planReactions(
  events,
  {
    now = new Date().toISOString(),
    cooldownMs = 15 * 60_000,
    quietHours = null,
    maxChatsPerWake = 3,
    lastTouched = new Map(),
  } = {},
) {
  if (inQuietHours(now, quietHours)) {
    // Nothing at all, including the notification.
    //
    // It is tempting to notify anyway and defer only the archive read, on the
    // grounds that a self-note is the safe half of sending. But writing a
    // self-note *is* a browser interaction: it opens a conversation and types.
    // Delivering one at 04:00 would produce exactly the activity signature
    // quiet hours exist to avoid, and would ping the user's own phone at 04:00
    // as a bonus. The events stay queued and are handled when the window closes.
    return {
      read: [],
      notify: [],
      archive: [],
      deferred: events.map((e) => ({ ...e, why: "quiet-hours" })),
      reason: "quiet-hours",
    };
  }

  const at = Date.parse(now);
  const byChat = new Map();
  const notify = [];
  const archive = [];
  const deferred = [];

  for (const event of events) {
    if (!INCOMING.has(event.kind)) {
      // Nothing arrived and nothing is owed. `unread-cleared` means a human
      // already dealt with it, and `own-message` means the user themselves
      // wrote it from their phone. Both are worth having recorded — they are
      // what makes the next diff correct, and own-message is a commitment
      // extraction should eventually see — and neither is worth waking anyone
      // for. They are closed out where they stand.
      archive.push({ ...event, why: `${event.kind}-is-informational` });
      continue;
    }

    // Every incoming event is reported, whatever happens to the read below.
    // Deferral is a decision about spending browser interactions, never about
    // whether the user gets told something arrived.
    notify.push(event);

    const touchedAt = lastTouched.get(event.chat);
    if (touchedAt && at - Date.parse(touchedAt) < cooldownMs) {
      deferred.push({ ...event, why: "cooldown" });
      continue;
    }

    const existing = byChat.get(event.chat);
    if (existing) {
      existing.events.push(event);
      continue;
    }
    byChat.set(event.chat, { chat: event.chat, events: [event] });
  }

  const candidates = [...byChat.values()];
  const read = candidates.slice(0, maxChatsPerWake);
  for (const over of candidates.slice(maxChatsPerWake)) {
    for (const event of over.events) deferred.push({ ...event, why: "fan-out-cap" });
  }

  return { read, notify, archive, deferred, reason: null };
}

/**
 * Claim, gate, top up, and report — the whole reaction, with the browser and the
 * store injected.
 *
 * Same shape as `ingestWith` and `fetchMediaWith`: the sequencing and every
 * decision in it are testable without a WhatsApp session, and `whatsapp.js`
 * supplies only the two things that genuinely need one.
 *
 * Events are deliberately NOT completed here. The caller acks them after the
 * user has actually been told, so a crash in between leaves them pending and the
 * notification arrives late rather than never. What stops the retry re-reading
 * the chat is the cooldown, not the ack.
 */
export async function reactWith(
  { store, ingest, now = () => new Date().toISOString() },
  { limit = 25, settings = {} } = {},
) {
  const { cooldownMs, maxChatsPerWake, maxScrolls = 2, quietHours, quietHoursRaw = "" } = settings;
  const at = now();

  if (quietHoursRaw && !quietHours) {
    // An unparseable window must not silently mean "no quiet hours": the
    // operator asked for a limit and would not be getting one.
    const error = new Error(
      `WA_QUIET_HOURS is set to "${quietHoursRaw}" but is not a HH:MM-HH:MM window, so quiet ` +
        "hours cannot be honoured. Fix it or unset it.",
    );
    error.statusCode = 500;
    throw error;
  }

  // Checked before claiming, so a quiet tick leaves the queue untouched instead
  // of taking a lease it has no intention of using.
  if (inQuietHours(at, quietHours)) {
    return {
      quiet: true,
      reason: "quiet-hours",
      quietHours: quietHoursRaw,
      events: [],
      read: [],
      deferred: store.eventStats().pending,
      note: "Inside quiet hours. Nothing was read, nothing was claimed, and nothing should be sent.",
    };
  }

  const claimed = store.claimEvents({ limit });
  if (!claimed.length) {
    return { quiet: false, events: [], read: [], deferred: 0, note: "No pending events." };
  }

  // The store speaks SQL column names; the rules speak the observer's shape.
  const events = claimed.map((row) => ({
    key: row.key,
    chat: row.chat,
    kind: row.kind,
    preview: row.preview ?? "",
    unread: row.unread ?? 0,
    observedAt: row.observed_at,
    attempts: row.attempts,
  }));

  const plan = planReactions(events, {
    now: at,
    cooldownMs,
    quietHours,
    maxChatsPerWake,
    lastTouched: store.lastTouched(),
  });

  // Informational changes close out where they stand: nothing to fetch, and
  // nobody needs telling they read their own phone.
  if (plan.archive.length) store.completeEvents(plan.archive.map((e) => e.key));

  if (!plan.notify.length) {
    // Release rather than hold: the next tick should reconsider these once the
    // cooldown or the cap has moved, not find them leased and idle.
    const held = plan.deferred.map((e) => e.key);
    if (held.length) store.releaseEvents(held);
    return {
      quiet: false,
      events: [],
      read: [],
      deferred: held.length,
      note: "Only informational changes since the last check. Nothing to report.",
    };
  }

  const read = [];
  for (const target of plan.read) {
    try {
      // Through the same ingest path a user-initiated archive uses, so the
      // interaction budget applies unchanged. An event cannot buy extra
      // interactions.
      const result = await ingest({ chat: target.chat, mode: "top-up", maxScrolls });
      store.touchChat(target.chat, "event-top-up");
      read.push({ chat: target.chat, inserted: result.inserted, scanned: result.scanned });
    } catch (error) {
      // A failed read must not lose the notification. The user still needs to
      // know something arrived, and the preview is enough to say so.
      store.touchChat(target.chat, "event-top-up-failed");
      read.push({ chat: target.chat, error: error?.message || String(error) });
    }
  }

  return {
    quiet: false,
    events: plan.notify,
    read,
    deferred: plan.deferred.length,
    deferredWhy: [...new Set(plan.deferred.map((e) => e.why))],
  };
}
