/**
 * What the model reads in place of content it cannot see.
 *
 * A message with no text of its own — a voice note, a photo, a PDF, a reaction —
 * still has to arrive as a readable line, because `text` is what the model reads
 * and an empty string is indistinguishable from silence. `readChat` once ended
 * in `.filter((m) => m.text)`, so every one of those rows was discarded before
 * anyone saw it: a chat full of voice messages read as a quiet chat, and the
 * agent could not report the gap because it never knew there was one.
 *
 * The rule here is the opposite: **nothing is dropped.** A kind with no label of
 * its own becomes `unrecognised attachment` and still carries whatever detail was
 * found, so the agent can say "there is something here I cannot read".
 *
 * ── Why this is a whole module for one function ─────────────────────────────
 * `placeholderText` is the SHARED VOCABULARY. The bridge renders it when the
 * transport hands over a message (`transport.js`), the archive stores what it
 * produced, and Go carries a second copy for messages it summarises before the
 * bridge sees them — so the two implementations have to agree, and the agreement
 * is asserted in `test/transport.test.js` rather than assumed. A label invented
 * at a call site would put two names for one thing into the same archive.
 *
 * ── What used to be here ────────────────────────────────────────────────────
 * `classifyRow` and its supporting parsers: `KINDS` (WhatsApp's `data-icon`
 * names and localized aria-labels, in candidate order), `parseAuthorLabel`,
 * `parseClock`, `parseDurationSeconds`, `findFilename`. They turned a scraped
 * DOM row into a message, and they were deleted with the browser that produced
 * those rows — the protocol states a message's kind, its author, its exact
 * instant and its duration as fields, so there is nothing left to infer from a
 * rendering. Nothing in `src/` had imported them since; only their own tests had.
 *
 * That deletion is the point of `test/anti-corruption-layer.test.js`: WhatsApp's
 * markup was a standing liability, and the way it stopped being one was that
 * every line which knew about it went away.
 */

/**
 * What a person would call each kind, because it is read as the body of a
 * message that has no text of its own.
 */
const LABEL = {
  voice: "voice note",
  audio: "audio",
  image: "image",
  video: "video",
  gif: "gif",
  sticker: "sticker",
  document: "document",
  location: "location",
  contact: "contact card",
  poll: "poll",
  deleted: "deleted message",
  system: "system message",
  unknown: "unrecognised attachment",

  // Added when the protocol layer stopped filing these as `unknown`.
  reaction: "reaction",
  video_note: "video note",
  album: "album",
  poll_vote: "poll vote",
  event: "event",
  pinned: "pinned message",
  kept: "kept message",
  group_invite: "group invite",
  comment: "comment",
  call_log: "call",
  business: "business message",
  payment: "payment message",
};

/** Seconds as WhatsApp writes them: 0:37, 3:42, 1:02:03. */
function formatDuration(total) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The string the model reads in place of content it cannot see. */
export function placeholderText({ kind, durationSeconds, filename, caption, label } = {}) {
  const name = LABEL[kind] || LABEL.unknown;
  const detail =
    durationSeconds !== undefined
      ? formatDuration(durationSeconds)
      : filename || (kind === "unknown" ? label : undefined);

  const head = detail ? `[${name} · ${detail}]` : `[${name}]`;
  return caption ? `${head} ${caption}` : head;
}
