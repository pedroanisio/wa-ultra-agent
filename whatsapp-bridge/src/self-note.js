/**
 * Self-notes: the agent writes to the user's own chat, and nowhere else.
 *
 * This is the safe half of sending. A note to yourself cannot reach the wrong
 * person, cannot be unrecallable, and leaves the actual decision to send on the
 * user's phone, where they copy the text into the real conversation. That is
 * why the two-phase prepare/commit dance does not apply here: the recipient is
 * a constant, so there is nothing for a human to confirm.
 *
 * ── What changed with the protocol transport ────────────────────────────────
 * The old safety argument rested entirely on one comparison: the conversation
 * WhatsApp Web had open must be exactly the configured self chat, because
 * `openChat()` typed into a search box and clicked the first result, and "Joao"
 * can open "Joao Antunes". That whole class of mistake is gone. The transport
 * addresses the note to the account's own JID, read from the device store and
 * never accepted from a caller, so there is no name to match and nothing to
 * mis-resolve — see `handleSendSelf` in the transport's httpapi.
 *
 * `WA_SELF_CHAT_NAME` is still required. It no longer routes anything, but it
 * remains the switch that makes the feature live at all, and an operator who
 * has not set it has not asked for an agent that writes to their WhatsApp.
 *
 * Kept free of transport specifics so the rules can be tested without a server;
 * the sending dependency is injected.
 */

/** A self-note is at most a context line plus the body. */
export const MAX_MESSAGES = 2;

/** Matches the ceiling on `whatsapp_send_prepare`, for the same reason. */
export const MAX_MESSAGE_CHARS = 4000;

function refuse(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Config-level checks, cheap and browser-free. Run before opening anything, or
 * a missing env var surfaces as "not linked to WhatsApp" and sends the operator
 * to fetch their phone to fix a text file.
 *
 * Enabled by default, unlike `WA_ALLOW_SEND`. The gate that actually matters is
 * `WA_SELF_CHAT_NAME`: without it the bridge does not know which chat is yours,
 * so nothing can be written and the feature is inert until configured. A
 * boolean on top of that would be ceremony, and this path displaces strictly
 * more dangerous ones.
 */
export function assertSelfNoteEnabled(env = process.env) {
  if (env.WA_ALLOW_SELF_NOTE === "false") {
    throw refuse(
      'Self-notes are disabled. Remove WA_ALLOW_SELF_NOTE or set it to "true" to enable them.',
      403,
    );
  }
}

/**
 * The switch, alone.
 *
 * Split out of the check below because the two questions stopped having the same
 * answer. On the protocol transport the recipient is the account's OWN key, read
 * from the live session — there is no title to compare, so `WA_SELF_CHAT_NAME`
 * is not merely unnecessary, requiring it would send an operator to their phone
 * to copy a string that nothing then uses. What both paths still share is the
 * off switch.
 */
export function assertSelfNoteConfigured(env = process.env) {
  assertSelfNoteEnabled(env);

  const name = (env.WA_SELF_CHAT_NAME || "").trim();
  if (!name) {
    throw refuse(
      "WA_SELF_CHAT_NAME is unset, so the bridge does not know which chat is yours. Set it to the " +
        "exact title WhatsApp shows above your own chat — open it and copy the header verbatim.",
      403,
    );
  }
  return name;
}

/**
 * Validate and trim the messages to write.
 *
 * The cap is not cosmetic. Each message lands as its own notification on the
 * operator's phone, so a burst is worse to receive than one dense note — and a
 * digest is what a self-note is for.
 */
export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) throw refuse("messages must be an array of strings.", 400);
  if (messages.length === 0) throw refuse("Refusing to write an empty self-note.", 400);
  if (messages.length > MAX_MESSAGES) {
    throw refuse(
      `A self-note is at most ${MAX_MESSAGES} messages and ${messages.length} were given. ` +
        "Write one dense message rather than a burst.",
      400,
    );
  }

  return messages.map((message, index) => {
    if (typeof message !== "string") throw refuse(`Message ${index + 1} is not a string.`, 400);
    const text = message.trim();
    if (!text) throw refuse(`Message ${index + 1} is empty.`, 400);
    if (text.length > MAX_MESSAGE_CHARS) {
      throw refuse(
        `Message ${index + 1} is ${text.length} characters; the limit is ${MAX_MESSAGE_CHARS}.`,
        400,
      );
    }
    return text;
  });
}

/**
 * Write the note, through the transport.
 *
 * `send` is injected as `(message) => Promise` and is expected to be the
 * transport's `POST /send/self`: it resolves the recipient itself, so this
 * function never handles an address at all. Messages go one at a time and in
 * order, because two notes are a context line followed by its body and reading
 * them reversed is worse than useless.
 */
export async function sendSelfNoteWith({ env, send }, { messages }) {
  // Config and input first, so neither failure is reported as a transport problem.
  // The switch alone: the recipient is the account's own address, so there is
  // no configured title left to honour. See assertSelfNoteEnabled.
  assertSelfNoteEnabled(env);
  const outgoing = normalizeMessages(messages);

  const sent = [];
  for (const message of outgoing) {
    sent.push(await send(message));
  }
  return { sent: sent.length, messages: outgoing };
}
