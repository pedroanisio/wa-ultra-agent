/**
 * Fetching the payload behind a media message.
 *
 * This build of WhatsApp Web renders no stable per-message id — `data-id` is
 * absent — so a message can only be addressed by position: "the third from the
 * end of this chat". Position is inherently racy. One new message arriving
 * between the read and the fetch shifts every index by one, and the wrong
 * attachment is a privacy failure, not a glitch.
 *
 * So the caller states what it expects to find there and the bridge refuses if
 * the row has changed underneath it. Same shape as the self-chat assertion in
 * `self-note.js`: verify first, act second, never the other way round.
 *
 * Kept free of Playwright so the rules can be tested without a browser; the
 * page-driving dependencies are injected.
 */

import { messageKey } from "./history.js";

/** Kinds that have bytes behind them. Everything else is a refusal. */
export const DOWNLOADABLE_KINDS = ["voice", "audio", "image", "video", "document", "sticker", "gif"];

/**
 * A base64 payload is persisted in session history and re-sent on every
 * subsequent model call, and eve warns above 3 MiB. This is the default ceiling
 * for anything headed to the model; audio going to a transcription endpoint
 * instead may raise it.
 */
export const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;

const EXTENSION_TYPES = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  txt: "text/plain",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** What WhatsApp actually stores for each kind, when the name tells us nothing. */
const KIND_TYPES = {
  voice: "audio/ogg",
  audio: "audio/mpeg",
  image: "image/jpeg",
  video: "video/mp4",
  sticker: "image/webp",
  gif: "image/gif",
  document: "application/octet-stream",
};

function refuse(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function mediaTypeFor(filename, kind) {
  const extension = String(filename || "")
    .split(".")
    .pop()
    ?.toLowerCase();

  if (extension && extension !== String(filename).toLowerCase() && EXTENSION_TYPES[extension]) {
    return EXTENSION_TYPES[extension];
  }
  return KIND_TYPES[kind] || "application/octet-stream";
}

export function assertDownloadable(kind) {
  if (DOWNLOADABLE_KINDS.includes(kind)) return;

  if (kind === "unknown") {
    throw refuse(
      "That row's kind could not be identified, so there is nothing to fetch. Inspect it with " +
        "/debug/rows and extend the signal table in message-kind.js.",
      400,
    );
  }
  throw refuse(`A "${kind}" message has no attachment to fetch.`, 400);
}

export function assertWithinCap(sizeBytes, maxBytes = DEFAULT_MAX_BYTES) {
  if (sizeBytes <= maxBytes) return;
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  throw refuse(
    `The attachment is ${mb(sizeBytes)} MB and the limit is ${mb(maxBytes)} MB. It is not fetched: ` +
      "a payload this size would be re-sent to the model on every later turn.",
    413,
  );
}

/**
 * Find the addressed row and prove it is still the one the caller meant.
 *
 * `expect` is optional but the whole point: without it, a message arriving
 * between the read and the fetch silently redirects the request to a different
 * attachment.
 */
export function resolveTarget(rows, { fromEnd, expect = {} } = {}) {
  const target = (rows || []).find((row) => row.fromEnd === fromEnd);
  if (!target) {
    throw refuse(
      `No message at position ${fromEnd} from the end of this chat. Read the chat again — the ` +
        "window may have moved.",
      404,
    );
  }

  const disagreements = [];
  if (expect.kind && expect.kind !== target.kind) {
    disagreements.push(`expected a "${expect.kind}" but found a "${target.kind}"`);
  }
  if (expect.from && expect.from !== target.from) {
    disagreements.push(`expected it from "${expect.from}" but it is from "${target.from}"`);
  }
  if (expect.time && expect.time !== target.time) {
    disagreements.push(`expected it at "${expect.time}" but it is at "${target.time}"`);
  }

  if (disagreements.length) {
    throw refuse(
      `The message at position ${fromEnd} is not the one you read: ${disagreements.join("; ")}. ` +
        "New messages have shifted the chat. Read it again and retry with the new position.",
      409,
    );
  }
  return target;
}

/**
 * Open the chat, verify the addressed row, download it, and return base64.
 *
 * `downloadRow(target)` is the only step that touches the browser; it returns
 * `{ buffer, suggestedFilename }`.
 */
export async function fetchMediaWith(
  { openChat, readRows, downloadRow },
  { chat, fromEnd, expect, maxBytes = DEFAULT_MAX_BYTES },
) {
  const resolved = await openChat(chat);
  const rows = await readRows();

  // Both of these throw before anything is downloaded.
  const target = resolveTarget(rows, { fromEnd, expect });
  assertDownloadable(target.kind);

  const { buffer, suggestedFilename } = await downloadRow(target);
  assertWithinCap(buffer.length, maxBytes);

  // The row's own filename is what the user sees in WhatsApp; the browser's
  // suggestion is often "download (1).bin".
  const filename = target.media?.filename || suggestedFilename;

  return {
    chat: resolved.opened,
    exactMatch: resolved.exactMatch,
    fromEnd,
    // The archive's id for this same row, computed the one way it is ever
    // computed (history.js). `fromEnd` addresses a position and expires the
    // moment a message arrives; this addresses the message itself, which is
    // what a transcript has to be filed under. Present whether or not the chat
    // has been archived — it is derived from the row, not looked up.
    key: messageKey(resolved.opened, target),
    kind: target.kind,
    from: target.from,
    time: target.time,
    filename,
    mediaType: mediaTypeFor(filename, target.kind),
    sizeBytes: buffer.length,
    base64: buffer.toString("base64"),
  };
}
