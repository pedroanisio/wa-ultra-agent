import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyRow, parseDurationSeconds, placeholderText } from "../src/message-kind.js";

/**
 * Until now a row with no text was dropped, so a chat full of voice notes read
 * as a quiet chat. These tests fix the opposite requirement: every row produces
 * a message, and one that cannot be identified says so rather than vanishing.
 */

/** The shape `readChat` extracts from each row in the browser. */
function row(overrides = {}) {
  return {
    meta: "[14:32, 10/08/2026] Helena: ",
    bodyText: "",
    rowText: "",
    icons: [],
    ariaLabels: [],
    titles: [],
    ...overrides,
  };
}

/* ---------------------------------------------------------------- *
 * Duration
 * ---------------------------------------------------------------- */

test("duration: parses m:ss", () => {
  assert.equal(parseDurationSeconds("3:42"), 222);
});

test("duration: parses a leading zero minute", () => {
  assert.equal(parseDurationSeconds("0:07"), 7);
});

test("duration: parses h:mm:ss", () => {
  assert.equal(parseDurationSeconds("1:02:03"), 3723);
});

test("duration: finds a duration embedded in surrounding text", () => {
  assert.equal(parseDurationSeconds("Voice message 3:42"), 222);
});

test("duration: returns undefined for text with no duration", () => {
  assert.equal(parseDurationSeconds("olá tudo bem"), undefined);
  assert.equal(parseDurationSeconds(""), undefined);
  assert.equal(parseDurationSeconds(undefined), undefined);
});

test("duration: does not read a clock time as a duration", () => {
  // A bare "14:32" in a row is the timestamp, not a length.
  assert.equal(parseDurationSeconds("14:32", { maxMinutes: 10 }), undefined);
});

/* ---------------------------------------------------------------- *
 * Text messages still behave exactly as before
 * ---------------------------------------------------------------- */

test("text: a row with body text is a text message", () => {
  const m = classifyRow(row({ bodyText: "Oi, tudo bem?" }));
  assert.equal(m.kind, "text");
  assert.equal(m.text, "Oi, tudo bem?");
  assert.equal(m.media, undefined);
});

test("text: prefers the body span over the row's full innerText", () => {
  const m = classifyRow(row({ bodyText: "real message", rowText: "14:32 real message ✓✓" }));
  assert.equal(m.text, "real message");
});

test("text: keeps author and time from the bubble metadata", () => {
  const m = classifyRow(row({ bodyText: "hi" }));
  assert.equal(m.from, "Helena");
  assert.equal(m.time, "10/08/2026 14:32");
});

/* ---------------------------------------------------------------- *
 * Media — the rows that used to disappear
 * ---------------------------------------------------------------- */

// The `rowText` fixtures below carry a trailing wall clock, because every one
// of the 28 rows captured from a live session does: "0:29\n1×\n16:46". They
// were originally written as a bare duration, which no real row renders, and
// that shape hid the bug where a voice note with no duration line adopted the
// clock as its length.

test("voice: identified from an audio icon, with its duration", () => {
  const m = classifyRow(row({ icons: ["audio-play", "status-check"], rowText: "0:37\n14:32" }));
  assert.equal(m.kind, "voice");
  assert.equal(m.media.durationSeconds, 37);
});

test("voice: identified from an English aria-label", () => {
  const m = classifyRow(row({ ariaLabels: ["Voice message"], rowText: "3:42\n14:32" }));
  assert.equal(m.kind, "voice");
  assert.equal(m.media.durationSeconds, 222);
});

test("voice: identified from a Portuguese aria-label", () => {
  const m = classifyRow(row({ ariaLabels: ["Mensagem de voz"], rowText: "3:42" }));
  assert.equal(m.kind, "voice");
});

test("voice: survives having no readable duration", () => {
  const m = classifyRow(row({ icons: ["ptt-status"] }));
  assert.equal(m.kind, "voice");
  assert.equal(m.media.durationSeconds, undefined);
  assert.ok(m.text.length > 0, "still produces a placeholder");
});

test("image: identified from an image icon", () => {
  assert.equal(classifyRow(row({ icons: ["status-image"] })).kind, "image");
});

test("image: identified from a Portuguese label", () => {
  assert.equal(classifyRow(row({ ariaLabels: ["Imagem"] })).kind, "image");
});

test("video: identified from a video label, with duration", () => {
  const m = classifyRow(row({ ariaLabels: ["Video"], rowText: "0:15\n14:32" }));
  assert.equal(m.kind, "video");
  assert.equal(m.media.durationSeconds, 15);
});

test("document: identified, and keeps the filename", () => {
  const m = classifyRow(
    row({ icons: ["document-doc"], rowText: "Autorizacao-Excursao.pdf\n2 pages" }),
  );
  assert.equal(m.kind, "document");
  assert.equal(m.media.filename, "Autorizacao-Excursao.pdf");
});

test("document: finds a filename anywhere in the row text", () => {
  const m = classifyRow(row({ ariaLabels: ["Documento"], rowText: "1 página\nboleto agosto.pdf" }));
  assert.equal(m.media.filename, "boleto agosto.pdf");
});

test("sticker, gif, location, contact and poll are each identified", () => {
  assert.equal(classifyRow(row({ ariaLabels: ["Sticker"] })).kind, "sticker");
  assert.equal(classifyRow(row({ icons: ["gif"] })).kind, "gif");
  assert.equal(classifyRow(row({ ariaLabels: ["Localização"] })).kind, "location");
  assert.equal(classifyRow(row({ ariaLabels: ["Contact card"] })).kind, "contact");
  assert.equal(classifyRow(row({ ariaLabels: ["Enquete"] })).kind, "poll");
});

test("caption: media with text keeps the caption and stays media", () => {
  const m = classifyRow(row({ icons: ["status-image"], bodyText: "olha isso" }));
  assert.equal(m.kind, "image");
  assert.equal(m.media.caption, "olha isso");
  assert.match(m.text, /olha isso/);
});

/* ---------------------------------------------------------------- *
 * Rows that are not messages
 * ---------------------------------------------------------------- */

test("deleted: recognised in English and Portuguese", () => {
  assert.equal(classifyRow(row({ bodyText: "This message was deleted" })).kind, "deleted");
  assert.equal(classifyRow(row({ bodyText: "Esta mensagem foi apagada" })).kind, "deleted");
});

test("system: the end-to-end encryption notice is not a message", () => {
  const m = classifyRow(
    row({ meta: "", rowText: "Messages and calls are end-to-end encrypted. No one outside of this chat..." }),
  );
  assert.equal(m.kind, "system");
});

test("system: a row with no bubble metadata and no media is a system row", () => {
  assert.equal(classifyRow(row({ meta: "", rowText: "TODAY" })).kind, "system");
});

/* ---------------------------------------------------------------- *
 * The safety property: nothing is ever dropped
 * ---------------------------------------------------------------- */

test("unknown: an unrecognised media row is reported, never dropped", () => {
  const m = classifyRow(row({ icons: ["some-future-whatsapp-icon"] }));
  assert.equal(m.kind, "unknown");
  assert.ok(m.text.length > 0, "an unreadable row must still say something");
});

test("unknown: keeps the label it did find, so a selector can be repaired", () => {
  const m = classifyRow(row({ ariaLabels: ["Bananagram from Helena"] }));
  assert.equal(m.kind, "unknown");
  assert.match(m.media.label, /Bananagram/);
});

test("every classification produces non-empty text", () => {
  const samples = [
    row({ bodyText: "hi" }),
    row({ icons: ["audio-play"] }),
    row({ ariaLabels: ["Imagem"] }),
    row({ icons: ["document-doc"], rowText: "x.pdf" }),
    row({ ariaLabels: ["Sticker"] }),
    row({ icons: ["nonsense"] }),
    row({ meta: "", rowText: "TODAY" }),
    row({}),
  ];
  for (const sample of samples) {
    const m = classifyRow(sample);
    assert.ok(m.text && m.text.trim().length > 0, `${m.kind} produced empty text`);
  }
});

/* ---------------------------------------------------------------- *
 * Placeholder wording — what the model actually reads
 * ---------------------------------------------------------------- */

test("placeholder: names the kind and the duration", () => {
  assert.equal(placeholderText({ kind: "voice", durationSeconds: 222 }), "[voice note · 3:42]");
});

test("placeholder: omits an unknown duration rather than printing 0:00", () => {
  assert.equal(placeholderText({ kind: "voice" }), "[voice note]");
});

test("placeholder: names a document by its filename", () => {
  assert.equal(
    placeholderText({ kind: "document", filename: "boleto.pdf" }),
    "[document · boleto.pdf]",
  );
});

test("placeholder: appends a caption when there is one", () => {
  assert.equal(
    placeholderText({ kind: "image", caption: "olha isso" }),
    "[image] olha isso",
  );
});

test("placeholder: an unknown row says so in words the model can repeat", () => {
  assert.match(placeholderText({ kind: "unknown" }), /unrecognised|unknown/i);
});

/* ================================================================ *
 * Rows captured from a live session via /debug/message-rows.
 *
 * Everything below is real DOM shape, not invented. Three bugs showed up in
 * an actual backfill of one conversation — 17 of 22 rows had no sender, 6 of
 * 22 were classified `system` with a bare clock as their body, and two read
 * "[unrecognised attachment · You:]" — and all three trace back to signals
 * that were present in the row and not being read.
 * ================================================================ */

/** A media row exactly as the browser hands it over: no data-pre-plain-text. */
const liveRow = (over = {}) => ({
  meta: "",
  bodyText: "",
  rowText: "",
  icons: [],
  ariaLabels: [],
  titles: [],
  ...over,
});

/* ---------------------------------------------------------------- *
 * The author is on the row, and was being thrown away
 * ---------------------------------------------------------------- */

test("live: a voice note carries its sender, which lives in the first aria-label", () => {
  // Real row. `data-pre-plain-text` exists only on TEXT bubbles, so reading the
  // author from it alone lost the sender on every voice note, photo and PDF —
  // 17 of 22 rows in the conversation this was captured from.
  const m = classifyRow(
    liveRow({
      icons: ["ptt-status"],
      ariaLabels: ["Mariana de Souza e Lima:", "Play voice message", "Voice message"],
      rowText: "0:29\n1×\n16:46",
    }),
  );

  assert.equal(m.kind, "voice");
  assert.equal(m.from, "Mariana de Souza e Lima", "the trailing colon is not part of the name");
});

test("live: an outgoing row is marked outgoing from its own label", () => {
  // WhatsApp writes "You:" rather than the account's name. Reported faithfully
  // and flagged outgoing, rather than invented as a person.
  const m = classifyRow(
    liveRow({ icons: ["tail-out"], ariaLabels: ["You:", "Open picture"], rowText: "16:46" }),
  );

  assert.equal(m.outgoing, true);
  assert.equal(m.from, "You");
});

test("live: a text row still prefers the real name from the bubble metadata", () => {
  // "[19:41, 7/21/2026] Joao Vitor Rocha: " — when the row names the author
  // properly, that wins over the generic "You:".
  const m = classifyRow({
    meta: "[19:41, 7/21/2026] Joao Vitor Rocha: ",
    bodyText: "Mandei para ela",
    rowText: "Mandei para ela\n19:40",
    icons: [],
    ariaLabels: ["You:"],
    titles: [],
  });

  assert.equal(m.from, "Joao Vitor Rocha");
  assert.equal(m.kind, "text");
  assert.equal(m.time, "7/21/2026 19:41");
});

/* ---------------------------------------------------------------- *
 * "Open picture" is a photo, not a system notice
 * ---------------------------------------------------------------- */

test("live: a photo is recognised from 'Open picture'", () => {
  // This is the whole junk-row bug. The image matcher looked for image/imagem/
  // photo/foto; the live label is "Open picture". Nothing matched, the row had
  // no body and no bubble metadata, so it fell through to `system` — and its
  // text became the clock that happened to be its only innerText.
  const m = classifyRow(
    liveRow({
      icons: ["tail-in"],
      ariaLabels: ["Mariana de Souza e Lima:", "Open picture", "Forward media"],
      rowText: "16:45",
    }),
  );

  assert.equal(m.kind, "image");
  assert.equal(m.text, "[image]");
  assert.notEqual(m.text, "16:45", "a clock is never a message body");
});

test("live: a PDF is recognised from its icon and keeps its filename", () => {
  const m = classifyRow(
    liveRow({
      icons: ["tail-out", "document-PDF-icon"],
      ariaLabels: ["You:", " Read ", "Forward media"],
      titles: ['View "relatorio-anual.pdf"', "30 pages", "PDF", "790 kB"],
      rowText: "PDF\nrelatorio-anual.pdf\n30 pages•PDF•790 kB\n17:28",
    }),
  );

  assert.equal(m.kind, "document");
  assert.equal(m.media.filename, "relatorio-anual.pdf");
});

test("live: a video is recognised and does not mistake the clock for its length", () => {
  const m = classifyRow(
    liveRow({
      icons: ["tail-out", "video-pip", "media-play"],
      ariaLabels: ["You:", "Picture-in-picture mode"],
      rowText: "6:40\n17:44",
    }),
  );

  assert.equal(m.kind, "video");
  assert.equal(m.media.durationSeconds, 400, "6:40 is the video, 17:44 is the wall clock");
});

test("live: a voice note with no duration line does not adopt the clock as its length", () => {
  // Real row: "1×\n14:12". There is no duration rendered, and 14:12 is the time
  // of day. Reading it as a length reports a 14-minute voice note.
  const m = classifyRow(
    liveRow({
      icons: ["ptt-status"],
      ariaLabels: ["Mariana de Souza e Lima:", "Voice message"],
      rowText: "1×\n14:12",
    }),
  );

  assert.equal(m.kind, "voice");
  assert.equal(m.media.durationSeconds, undefined);
});

/* ---------------------------------------------------------------- *
 * The clock, and what the author label must never become
 * ---------------------------------------------------------------- */

test("live: a media row reports the wall clock as its time", () => {
  // Not a full timestamp — the row does not carry a date — but it is what the
  // media fingerprint compares against, and it was `undefined` for exactly the
  // rows that fingerprint is meant to protect.
  const m = classifyRow(
    liveRow({
      icons: ["ptt-status"],
      ariaLabels: ["Mariana de Souza e Lima:", "Voice message"],
      rowText: "0:39\n1×\n17:39",
    }),
  );

  assert.equal(m.time, "17:39");
});

test("live: an unidentifiable row never labels itself with the author", () => {
  // This produced "[unrecognised attachment · You:]". The author aria-label was
  // being used as the media's description because it happened to be first.
  const m = classifyRow(
    liveRow({ icons: ["tail-out"], ariaLabels: ["You:"], rowText: "13:21" }),
  );

  assert.equal(m.from, "You");
  assert.doesNotMatch(m.text, /You:/, "the author is not a description of the attachment");
});

test("live: the author label is not searched for a media kind", () => {
  // A contact genuinely called "Video Alves" must not turn every one of their
  // messages into a video.
  const m = classifyRow(
    liveRow({ ariaLabels: ["Video Alves:"], bodyText: "bom dia", rowText: "bom dia\n09:00" }),
  );

  assert.equal(m.kind, "text");
});
