/**
 * Turning whatever a caller calls a conversation into the address it is filed
 * under — in exactly one place, for every route that takes a chat.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 * On 12 August 2026 the agent was asked for the latest message in every group.
 * Eight groups came back with no messages at all, and it reported them as
 * unreadable — while 537, 570, 831 and 936 of their messages sat in the table.
 *
 * The archive had grown a second row for each of those chats, keyed by the
 * group's DISPLAY NAME rather than its protocol address, holding zero messages.
 * They were minted by the interaction twin: `saveInteractionModel({chat})` took
 * whatever string the agent passed and inserted it as a chat address (see
 * `store.chatId`). Resolution then checked `key === asked` FIRST, so the name
 * the agent read off the chat list matched the empty phantom and never reached
 * the real conversation. Typing the name WRONG worked; typing it right did not.
 *
 * Two rules follow, and they are the whole content of this module:
 *
 *   1. A protocol address always beats a name-keyed row. Both are legal keys —
 *      chats ingested before the transport are addressed by their rendered name
 *      — but when a name and an address both answer to the same string, the
 *      address is the conversation and the name is a shadow of it.
 *   2. A name that does not resolve is NOT a chat with no messages. Every caller
 *      gets `matched: "none"` and no key, so the difference between "I could not
 *      find that conversation" and "that conversation is empty" survives the
 *      trip back to the agent. It did not before, and that is why the model had
 *      to guess at a cause on the user's phone.
 *
 * Pure by construction: it takes the rows and the question, and returns the
 * decision. No database, no store handle, no clock — so every rule below is
 * testable directly, which is what `test/chat-address.test.js` does.
 */

import { foldName } from "./recipients.js";

/**
 * Whether this key is an address the protocol issued, rather than a name.
 *
 * The three shapes the transport files chats under: a LID (`<digits>@lid`), a
 * group JID (`<digits>-<digits>@g.us` or `<digits>@g.us`), a phone JID
 * (`<digits>@s.whatsapp.net`), `status@broadcast`, and the `pn:` digest used
 * when a chat is seen before its LID is known. Anything else is a display name
 * — either a chat that predates the transport, or a phantom.
 */
export function isProtocolAddress(key) {
  const value = String(key ?? "");
  return value.includes("@") || value.startsWith("pn:");
}

/** The words of a name, for the "every word you typed, in any order" match. */
function words(value) {
  return foldName(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

/**
 * Narrow several candidates to one, or say they cannot be narrowed.
 *
 * The preferences are ordered by how much they can be trusted, and each is only
 * consulted when the one before it left more than one row standing:
 *
 *   protocol address  — an address is the conversation; a name is a label.
 *   has messages      — between two addresses for the same person, the one that
 *                       holds correspondence is the one being asked about. This
 *                       is what keeps a provisional `pn:` row that never
 *                       received anything from shadowing the LID that did.
 *
 * Anything still tied is genuinely ambiguous and is refused rather than guessed:
 * reading the wrong person's chat is a smaller harm than writing to them, but it
 * is still a wrong answer given confidently.
 */
function narrow(candidates) {
  if (candidates.length <= 1) return candidates;

  const addressed = candidates.filter((chat) => isProtocolAddress(chat.key));
  const preferred = addressed.length > 0 ? addressed : candidates;
  if (preferred.length === 1) return preferred;

  const withMessages = preferred.filter((chat) => Number(chat.messages) > 0);
  return withMessages.length === 1 ? withMessages : preferred;
}

function ambiguous(asked, candidates) {
  const error = new Error(
    `"${asked}" matches ${candidates.length} conversations ` +
      `(${candidates.map((c) => c.displayName || c.key).join(", ")}). ` +
      "Refusing to choose. Use the chat's key, which is unique.",
  );
  error.statusCode = 409;
  return error;
}

/**
 * The address a question about a conversation is really about.
 *
 * @param chats  Rows as `store.chats()` returns them: `{ key, displayName, messages }`.
 * @param asked  Whatever the caller called it: an address, a display name, or
 *               an approximation of one.
 * @returns `{ key, matched }` where `matched` is `key`, `name`, `words` or
 *          `none`. `key` is null exactly when `matched` is `none`.
 * @throws   A 409 when two conversations answer to the name equally well.
 */
export function resolveChatAddress(chats, asked) {
  const question = String(asked ?? "").trim();
  if (!question) return { key: null, matched: "none" };

  const rows = Array.isArray(chats) ? chats : [];

  // An exact key and an exact name are collected TOGETHER rather than one
  // short-circuiting the other. The short-circuit is the bug: it made a phantom
  // named row beat the address it was a shadow of.
  const byKey = rows.filter((chat) => chat.key === question);
  const wanted = foldName(question);
  const byName = rows.filter(
    (chat) => chat.displayName && foldName(chat.displayName) === wanted && chat.key !== question,
  );

  const exact = [...byKey, ...byName];
  if (exact.length > 0) {
    const narrowed = narrow(exact);
    if (narrowed.length > 1) throw ambiguous(question, narrowed);
    const chosen = narrowed[0];
    return { key: chosen.key, matched: chosen.key === question ? "key" : "name" };
  }

  // Every word you typed, in any order — `familia ulian` finds `Familia (Ulian)`
  // only when the fold keeps both words, so this is a genuine fallback and not a
  // second spelling of the exact match.
  const asking = words(question);
  if (asking.length === 0) return { key: null, matched: "none" };

  const loose = rows.filter((chat) => {
    if (!chat.displayName) return false;
    const have = new Set(words(chat.displayName));
    return asking.every((word) => have.has(word));
  });

  const narrowed = narrow(loose);
  return narrowed.length === 1
    ? { key: narrowed[0].key, matched: "words" }
    : { key: null, matched: "none" };
}
