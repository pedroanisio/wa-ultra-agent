/**
 * The measured half of the interaction twin.
 *
 * A twin has two halves and they must not be confused. This file is the half
 * that is *counted*: how often each side writes, how long a reply takes, who
 * opens a conversation, how long it has been silent. None of it is inferred by
 * a model, so none of it can be hallucinated — it is arithmetic over rows that
 * were actually read.
 *
 * The other half — arcs, goals, contexts — is a model's reading of the same
 * messages, and lives behind the citation checks in `agent/lib/twin.ts`. Keeping
 * them apart is the point: when the agent says "you usually reply to her within
 * ten minutes and it has now been three days", the first clause is a fact about
 * the archive and the second is a fact about the clock, and neither depends on
 * an extraction pass being right.
 *
 * Every figure here is stated with the sample it came from. A median reply time
 * computed from two exchanges is not a habit, and a caller that cannot see the
 * sample size will treat it as one.
 */

/** A gap this long makes the next message an opening rather than a reply. */
const NEW_CONVERSATION_GAP_MINUTES = 6 * 60;

/** Below this many observations, a median is an anecdote. Reported, not hidden. */
export const HABIT_SAMPLE_FLOOR = 5;

function median(values) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10) / 10;
}

/**
 * Messages in time order, dropping anything whose timestamp could not be read.
 *
 * A row with no parseable time cannot be placed in a sequence, and guessing its
 * position corrupts every latency computed from it. It still counts toward the
 * totals; it just cannot contribute to the ordering-dependent figures.
 */
function ordered(messages) {
  return messages
    .filter((m) => m.sent_at_iso)
    .map((m) => ({ ...m, at: Date.parse(m.sent_at_iso) }))
    .filter((m) => Number.isFinite(m.at))
    .sort((a, b) => a.at - b.at || (a.id ?? 0) - (b.id ?? 0));
}

/**
 * How the two sides actually behave in one conversation.
 *
 * `nowIso` is injected rather than read from the clock so the same archive
 * always produces the same twin in a test.
 */
export function interactionMetrics(messages, { nowIso } = {}) {
  const now = Date.parse(nowIso ?? new Date().toISOString());
  const timed = ordered(messages);

  const empty = {
    messages: messages.length,
    timed: timed.length,
    directionKnown: 0,
    firstAt: undefined,
    lastAt: undefined,
    spanDays: undefined,
    silentDays: undefined,
    outgoingShare: undefined,
    medianCharsUser: undefined,
    medianCharsThem: undefined,
    medianReplyMinutesUser: undefined,
    medianReplyMinutesThem: undefined,
    replySampleUser: 0,
    replySampleThem: 0,
    initiationsUser: 0,
    initiationsThem: 0,
    lastInboundAt: undefined,
    lastOutboundAt: undefined,
    ballWith: undefined,
    activeHours: [],
    kinds: {},
    habitsAreThin: true,
  };

  if (!timed.length) return empty;

  const known = timed.filter((m) => m.outgoing !== null && m.outgoing !== undefined);
  const mine = known.filter((m) => Number(m.outgoing) === 1);
  const theirs = known.filter((m) => Number(m.outgoing) === 0);

  // Reply latency, and openings. Both need the same walk, and both are only
  // meaningful across a direction change: two consecutive messages from the
  // same person are one turn typed twice, not a reply.
  const replyMinutesUser = [];
  const replyMinutesThem = [];
  let initiationsUser = 0;
  let initiationsThem = 0;

  for (let i = 0; i < known.length; i++) {
    const message = known[i];
    const previous = known[i - 1];
    const gapMinutes = previous ? (message.at - previous.at) / 60_000 : Infinity;

    if (!previous || gapMinutes >= NEW_CONVERSATION_GAP_MINUTES) {
      if (Number(message.outgoing) === 1) initiationsUser++;
      else initiationsThem++;
      continue;
    }

    if (Number(previous.outgoing) === Number(message.outgoing)) continue;
    if (Number(message.outgoing) === 1) replyMinutesUser.push(gapMinutes);
    else replyMinutesThem.push(gapMinutes);
  }

  const hours = new Map();
  for (const message of timed) {
    // Wall-clock hour as WhatsApp rendered it — `parseSentAt` builds the
    // timestamp from the displayed local time, so this is the user's day, not
    // a timezone conversion of it.
    const hour = new Date(message.at).getUTCHours();
    hours.set(hour, (hours.get(hour) ?? 0) + 1);
  }

  const kinds = {};
  for (const message of messages) kinds[message.kind || "unknown"] = (kinds[message.kind || "unknown"] ?? 0) + 1;

  const firstAt = timed[0].sent_at_iso;
  const lastAt = timed[timed.length - 1].sent_at_iso;
  const lastInbound = [...theirs].reverse()[0];
  const lastOutbound = [...mine].reverse()[0];
  const lastKnown = known[known.length - 1];

  return {
    messages: messages.length,
    timed: timed.length,
    directionKnown: known.length,
    firstAt,
    lastAt,
    spanDays: Math.round((Date.parse(lastAt) - Date.parse(firstAt)) / 86_400_000),
    silentDays: Number.isFinite(now)
      ? Math.max(0, Math.round((now - Date.parse(lastAt)) / 86_400_000))
      : undefined,
    outgoingShare: known.length ? Math.round((mine.length / known.length) * 100) / 100 : undefined,
    medianCharsUser: median(mine.map((m) => (m.text || "").length)),
    medianCharsThem: median(theirs.map((m) => (m.text || "").length)),
    medianReplyMinutesUser: median(replyMinutesUser),
    medianReplyMinutesThem: median(replyMinutesThem),
    replySampleUser: replyMinutesUser.length,
    replySampleThem: replyMinutesThem.length,
    initiationsUser,
    initiationsThem,
    lastInboundAt: lastInbound?.sent_at_iso,
    lastOutboundAt: lastOutbound?.sent_at_iso,
    /**
     * Who owes the next message, by the only evidence there is: who spoke last.
     * A crude signal, and deliberately not dressed up as more — the obligations
     * table is where a real "they owe me" claim lives.
     */
    ballWith: lastKnown ? (Number(lastKnown.outgoing) === 1 ? "them" : "user") : undefined,
    activeHours: [...hours.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, 3)
      .map(([hour, count]) => ({ hour, count })),
    kinds,
    // The honest caveat, computed rather than remembered: below the floor these
    // medians describe a handful of exchanges, not how these two people talk.
    habitsAreThin:
      replyMinutesUser.length < HABIT_SAMPLE_FLOOR && replyMinutesThem.length < HABIT_SAMPLE_FLOOR,
  };
}

/**
 * How much of the archive the modelled half actually covers.
 *
 * The failure this exists to prevent: a twin built a month ago, presented today
 * as if it described the conversation as it now stands. `messagesSince` is the
 * number of archived messages that arrived after the last modelling pass, and a
 * non-zero value means the arcs below it are out of date by exactly that much.
 */
export function twinCoverage({ metrics, modelledAt, messagesSince, arcs = 0 }) {
  return {
    archivedMessages: metrics.messages,
    modelledAt,
    messagesSince,
    arcs,
    stale: !modelledAt || messagesSince > 0,
    // Never modelled at all is a different answer from "modelled, then drifted",
    // and the caller must not report the first as the second.
    reason: !modelledAt
      ? "this conversation has never been modelled"
      : messagesSince > 0
        ? `${messagesSince} message${messagesSince === 1 ? "" : "s"} arrived after the last modelling pass`
        : undefined,
  };
}
