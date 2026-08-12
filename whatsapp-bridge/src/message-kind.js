/**
 * What kind of message a rendered row actually is.
 *
 * Until now `readChat` ended in `.filter((m) => m.text)`, so every row without
 * text — voice notes, photos, PDFs, stickers, system notices — was discarded
 * before anyone saw it. A chat full of voice messages read as a quiet chat, and
 * the agent could not even report the gap because it never knew there was one.
 *
 * The rule here is the opposite: **a row is never dropped**. If it cannot be
 * identified it becomes `unknown` and still carries whatever label was found, so
 * the agent can say "there is something here I cannot read" and an operator can
 * repair the signal from `/debug/rows`.
 *
 * Kept free of Playwright: the browser hands back a plain description of each
 * row and everything below is decided in Node, where it can be tested.
 *
 * ── On the signals ──────────────────────────────────────────────────────────
 * `data-icon` values are preferred because they do not change with the
 * interface language. They are matched as SUBSTRINGS of a candidate list, the
 * same degrade-don't-break approach as `selectors.js`: one upstream rename costs
 * one kind, not the feature. aria-labels are the fallback and are localized, so
 * both English and Portuguese forms are listed — this account runs in
 * Portuguese, and an English-only matcher would silently classify everything as
 * `unknown`.
 */

/** Collapse WhatsApp's zero-width and directional marks out of scraped text. */
export const clean = (s) => (s || "").replace(/[‎‏‪-‮]/g, "").trim();

/**
 * Candidate signals per kind, in priority order.
 *
 * These icon names are the least verifiable part of this file — WhatsApp Web
 * ships them unversioned and they were not confirmed against a live session.
 * That is exactly why an unmatched row falls through to `unknown` rather than
 * being guessed at or dropped.
 */
const KINDS = [
  { kind: "voice", icons: ["ptt", "audio-play", "mic"], labels: [/voice message/i, /mensagem de voz/i, /áudio de voz/i] },
  { kind: "audio", icons: ["audio-file", "headphone"], labels: [/audio file/i, /arquivo de áudio/i, /^\s*áudio\s*$/i] },
  // "Open picture" is what a live session actually renders on a photo, and its
  // absence here classified every photo in a conversation as a system notice.
  // Matched as the whole phrase rather than the bare word on purpose: a video
  // row carries "Picture-in-picture mode", and `\bpicture\b` would claim it.
  {
    kind: "image",
    icons: ["status-image", "image", "photo"],
    labels: [/\bimage\b/i, /\bimagem\b/i, /\bphoto\b/i, /\bfoto\b/i, /\bopen picture\b/i, /\babrir (a )?imagem\b/i],
  },
  { kind: "video", icons: ["media-play", "video"], labels: [/\bvideo\b/i, /\bvídeo\b/i] },
  { kind: "gif", icons: ["gif"], labels: [/\bgif\b/i] },
  { kind: "sticker", icons: ["sticker"], labels: [/\bsticker\b/i, /figurinha/i] },
  { kind: "document", icons: ["document"], labels: [/\bdocument\b/i, /\bdocumento\b/i] },
  { kind: "location", icons: ["location", "pin-"], labels: [/\blocation\b/i, /localiza/i] },
  { kind: "contact", icons: ["vcard", "contact"], labels: [/contact card/i, /\bcontact\b/i, /\bcontato\b/i] },
  { kind: "poll", icons: ["poll"], labels: [/\bpoll\b/i, /enquete/i] },
];

const DELETED = [/this message was deleted/i, /mensagem foi apagada/i, /you deleted this message/i];

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

  // Added when the protocol layer stopped filing these as `unknown`. Each label
  // is what a person would call the thing, because it is read by the model as
  // the body of a message that has no text of its own.
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

/**
 * Find a media duration in a row's text.
 *
 * Every row also contains a clock timestamp, which has the same shape as a
 * duration. `exclude` removes the one we already read from the bubble metadata,
 * and `maxMinutes` rejects anything implausibly long for a WhatsApp attachment.
 */
export function parseDurationSeconds(text, { exclude = [], maxMinutes = 600 } = {}) {
  if (!text) return undefined;

  const skip = new Set(exclude.filter(Boolean));
  for (const match of String(text).matchAll(/\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b/g)) {
    const [raw, a, b, c] = match;
    if (skip.has(raw)) continue;

    const seconds =
      c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c);
    if (c === undefined && Number(a) > maxMinutes) continue;
    return seconds;
  }
  return undefined;
}

/** A line that looks like "boleto agosto.pdf" — a name ending in an extension. */
function findFilename(rowText) {
  for (const line of String(rowText || "").split("\n").map((l) => clean(l))) {
    if (line && /^[^\n]{1,120}\.[a-z0-9]{2,5}$/i.test(line)) return line;
  }
  return undefined;
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

/**
 * How WhatsApp names the account holder on their own messages, per language.
 *
 * It writes "You:" rather than the account's display name, so an outgoing media
 * row never states who sent it. Reported faithfully as "You" rather than
 * invented as a person — the account's real name appears on its *text* rows,
 * where the bubble metadata carries it, and reconciling the two is the caller's
 * job, not this file's guess.
 */
const SELF_LABELS = [/^you$/i, /^você$/i, /^voce$/i, /^tu$/i];

/**
 * The author, as the row itself states it.
 *
 * WhatsApp puts `aria-label="Mariana de Souza e Lima:"` on the row — first,
 * and with a trailing colon — for every message including media. Reading the
 * author only from `data-pre-plain-text`, which exists on TEXT bubbles alone,
 * lost the sender on every voice note, photo and PDF: 17 of 22 rows in the
 * conversation this was found in.
 */
export function parseAuthorLabel(ariaLabels = []) {
  const first = clean(ariaLabels[0] || "");
  if (!first.endsWith(":")) return undefined;
  return clean(first.slice(0, -1)) || undefined;
}

/**
 * The wall clock WhatsApp renders at the end of every bubble.
 *
 * Scanned from the END, because a media row's duration has the same shape and
 * comes first: "0:29\n1×\n16:46" is a 29-second voice note sent at 16:46. Read
 * the other way round it is a 16-minute voice note, and a row rendering no
 * duration at all ("1×\n14:12") becomes a 14-minute one.
 */
export function parseClock(rowText) {
  const lines = String(rowText || "")
    .split("\n")
    .map((line) => clean(line))
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^(\d{1,2}):([0-5]\d)$/.test(lines[i])) return lines[i];
  }
  return undefined;
}

function matchKind({ icons, ariaLabels, titles }) {
  const iconText = (icons || []).map((i) => String(i || "").toLowerCase());
  for (const candidate of KINDS) {
    if (iconText.some((icon) => candidate.icons.some((needle) => icon.includes(needle)))) {
      return candidate.kind;
    }
  }

  const labels = [...(ariaLabels || []), ...(titles || [])].map((l) => clean(l)).filter(Boolean);
  for (const candidate of KINDS) {
    if (labels.some((label) => candidate.labels.some((pattern) => pattern.test(label)))) {
      return candidate.kind;
    }
  }
  return undefined;
}

/**
 * Turn one extracted row into a message.
 *
 * Always returns something with non-empty `text`, because `text` is what the
 * model reads and an empty string is indistinguishable from silence.
 */
export function classifyRow(raw = {}) {
  const { meta = "", bodyText = "", rowText = "", ariaLabels = [], titles = [] } = raw;

  // "[19:41, 7/21/2026] Joao Vitor Rocha: " — present on TEXT bubbles only,
  // which is why it cannot be the sole source of the author.
  const stamp = String(meta).match(/\[(.+?),\s*(.+?)\]\s*(.*?):\s*$/);
  const stampClock = stamp?.[1];
  const author = parseAuthorLabel(ariaLabels);
  const clock = parseClock(rowText);

  // The author label is a name. It is never a description of an attachment and
  // never evidence of its kind — dropping it here is what stops a photo from a
  // contact called "Video Alves" being classified as a video, and what stopped
  // unidentifiable rows rendering as "[unrecognised attachment · You:]".
  const descriptiveLabels = author ? ariaLabels.slice(1) : ariaLabels;
  const signals = { icons: raw.icons, ariaLabels: descriptiveLabels, titles };

  const base = {
    // A full timestamp when the bubble carries one, the wall clock otherwise.
    // Media rows render no date at all, and `undefined` here left the media
    // fingerprint with nothing to check on exactly the rows it protects.
    time: stamp ? `${stamp[2]} ${stamp[1]}` : clock,
    from: stamp ? stamp[3] : author,
    ...(author && SELF_LABELS.some((pattern) => pattern.test(author)) ? { outgoing: true } : {}),
  };

  const body = clean(bodyText);
  if (DELETED.some((pattern) => pattern.test(body))) {
    return { ...base, kind: "deleted", text: body };
  }

  const kind = matchKind(signals);
  if (kind) {
    const media = {
      kind,
      durationSeconds: ["voice", "audio", "video"].includes(kind)
        ? parseDurationSeconds(rowText, { exclude: [stampClock, clock] })
        : undefined,
      filename: kind === "document" ? findFilename(rowText) : undefined,
      // Media can carry a caption; it is a real message and must survive.
      caption: body || undefined,
    };
    return { ...base, kind, media, text: placeholderText(media) };
  }

  if (body) return { ...base, kind: "text", text: body };

  // No text and no recognised media. An author label means this is somebody's
  // bubble whose kind is not known yet; without one it is a divider or a
  // notice. Getting that backwards turned every unrecognised photo into a
  // "system message" whose body was the clock it happened to render.
  const label = [...descriptiveLabels, ...titles].map((l) => clean(l)).find(Boolean);
  if (!stamp && !author) {
    return { ...base, kind: "system", text: clean(rowText) || placeholderText({ kind: "system" }) };
  }
  return {
    ...base,
    kind: "unknown",
    media: { kind: "unknown", label },
    text: placeholderText({ kind: "unknown", label }),
  };
}
