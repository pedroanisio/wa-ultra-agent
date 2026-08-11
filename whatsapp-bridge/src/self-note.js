/**
 * Self-notes: the agent writes to the user's own chat, and nowhere else.
 *
 * This is the safe half of sending. A note to yourself cannot reach the wrong
 * person, cannot be unrecallable, and leaves the actual decision to send on the
 * user's phone, where they copy the text into the real conversation. That is
 * why the two-phase prepare/commit dance does not apply here: the recipient is
 * a constant, so there is nothing for a human to confirm.
 *
 * The whole safety argument rests on one comparison — the conversation that is
 * open must be *exactly* the configured self chat. `openChat()` finds a chat by
 * typing into WhatsApp's search box and clicking the first result, so its answer
 * is a fuzzy match and must never be trusted on its own: "Joao" can open "Joao
 * Antunes". Everything below exists to make that mistake impossible rather than
 * unlikely.
 *
 * Kept free of Playwright so the rules can be tested without a browser; the
 * page-driving dependencies are injected.
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
export function assertSelfNoteConfigured(env = process.env) {
  if (env.WA_ALLOW_SELF_NOTE === "false") {
    throw refuse(
      'Self-notes are disabled. Remove WA_ALLOW_SELF_NOTE or set it to "true" to enable them.',
      403,
    );
  }

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
 * The cap is not cosmetic. Every message is a separate click-type-Enter cycle
 * against a real browser, which is both slow and part of the automation
 * footprint that gets accounts banned. A digest belongs in one dense message.
 */
export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) throw refuse("messages must be an array of strings.", 400);
  if (messages.length === 0) throw refuse("Refusing to write an empty self-note.", 400);
  if (messages.length > MAX_MESSAGES) {
    throw refuse(
      `A self-note is at most ${MAX_MESSAGES} messages and ${messages.length} were given. Each one ` +
        "is a separate browser interaction, so write one dense message rather than a burst.",
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
 * The comparison the whole feature rests on.
 *
 * Exact, after trimming. Not `includes`, not case-folded: "Joao" is a prefix of
 * "Joao Peixoto", and a private draft delivered to a similarly-named contact is
 * precisely the accident this path exists to prevent. A case-only mismatch fails
 * closed and the message names both strings, which is a five-second fix; the
 * opposite default has no fix at all once the message is delivered.
 */
export function assertSelfChatOpen(openTitle, expected) {
  const actual = (openTitle || "").trim();
  if (actual === expected) return;

  throw refuse(
    actual
      ? `Expected the self chat "${expected}" to be open but found "${actual}". Refusing to write.`
      : `No conversation is open; expected the self chat "${expected}". Refusing to write.`,
    409,
  );
}

/**
 * Open the self chat if it is not already open, verify it, then write.
 *
 * Dependencies are injected: `openChatTitle()` reads the header of whatever is
 * open, `openChat(query)` navigates by fuzzy search, and `typeAndSend(text)`
 * types one message and presses Enter.
 */
export async function sendSelfNoteWith({ env, openChatTitle, openChat, typeAndSend }, { messages }) {
  // Config and input first, so neither failure is reported as a browser problem.
  const expected = assertSelfNoteConfigured(env);
  const outgoing = normalizeMessages(messages);

  const current = (await openChatTitle()) || "";
  if (current.trim() !== expected) {
    const resolved = await openChat(expected);

    // openChat reports what it believes it opened. Reject a fuzzy hit here…
    if (!resolved?.exactMatch || resolved.opened !== expected) {
      throw refuse(
        `Searching for the self chat "${expected}" opened "${resolved?.opened || "nothing"}". ` +
          "Refusing to write. Check WA_SELF_CHAT_NAME against the chat header.",
        409,
      );
    }

    // …and then do not trust it: re-read the header that is actually rendered.
    assertSelfChatOpen(await openChatTitle(), expected);
  }

  // Sequential on purpose. A failure part-way leaves a partial note, which is
  // recoverable; interleaving two messages into a half-typed composer is not.
  for (const text of outgoing) await typeAndSend(text);

  return { sent: true, chat: expected, messages: outgoing, at: new Date().toISOString() };
}
