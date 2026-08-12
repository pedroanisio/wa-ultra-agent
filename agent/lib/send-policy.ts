/**
 * When a send has to be confirmed by a person.
 *
 * ── The two questions, and why the allowlist only answers one ───────────────
 *
 * The bridge's allowlist answers WHO may be written to, and it lives there
 * rather than here on purpose: a cap the agent enforces is a cap a confused
 * agent can talk itself out of. What it cannot answer is whether *this
 * particular message* is one the user would have wanted to word themselves.
 * Both people are on the allowlist; "on my way" and "I'll pay you Friday" are
 * not the same message to send in someone's name.
 *
 * The DOM path had a prepare/commit dance for this and it went with the browser.
 * This is its replacement, expressed as an eve approval policy so the pause is
 * durable and can be answered from any channel the user happens to be on —
 * including their own phone, via `/eve`.
 *
 * ── Why it errs towards asking ──────────────────────────────────────────────
 *
 * The two failures are not symmetrical. A needless approval costs one tap. A
 * missed one sends a promise, an apology or a sum of money under the user's own
 * name, to a real person, with no undo beyond a revoke that everyone sees.
 * So anything unreadable, unusually long, or matching a commitment shape asks.
 */

/** What eve's approval hook may return. */
export type ApprovalDecision = "user-approval" | "not-applicable";

/**
 * Past this, a message is a statement rather than a remark.
 *
 * Not a rule about writing — a proxy for substance. Nobody dictates four hundred
 * characters of small talk through an agent, and the cost of asking about the
 * rare long message that is is a single tap.
 */
const SUBSTANTIAL_CHARS = 320;

/**
 * Shapes that commit the user, in both languages this account is used in.
 *
 * Deliberately over-broad. Each entry is a thing a person would want to have
 * worded themselves, and a false positive here is an approval prompt, not a
 * mistake.
 */
/**
 * A note on the boundaries below.
 *
 * `\b` is defined against ASCII word characters, so it does NOT close after
 * "amanhã" or "reunião" — the accented letter is already a non-word character
 * and there is no transition left to match. Every pattern that can end on one
 * uses `(?!\w)` instead. This cost a test: "confirmo a reunião de amanhã" is a
 * commitment in the language half this account is written in, and it read as
 * small talk.
 */
const COMMITMENTS: RegExp[] = [
  // Money, in figures or in words.
  /\b(r\$|us\$|\$|€|£)\s*\d/i,
  /\b\d+([.,]\d+)?\s*(reais|real|euros?|dollars?|pounds?|mil|k)\b/i,
  /\b(pay|paid|transfer|deposit|refund|invoice|pix|pago|pagar|transfer[oi]|dep[óo]sito|dep[óo]sito|boleto)\b/i,

  // Agreeing to a time or a place.
  /\b(yes|sure|ok|okay|confirm(ed|o|ar)?|combinado|fechado|beleza)\b[^.!?]{0,40}\b(\d{1,2}\s*(am|pm|h)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|amanh[ãa]|tomorrow|today|hoje)(?!\w)/i,
  /\b(i'?ll be there|i will be there|see you (at|on)|let'?s meet|estarei l[áa]|te encontro|nos vemos)\b/i,
  /(?<!\w)(reuni[ãa]o|meeting|call)(?!\w)[^.!?]{0,30}(?<!\w)(amanh[ãa]|hoje|tomorrow|today|\d{1,2}\s*(am|pm|h))(?!\w)/i,
  /\bon the \d{1,2}(st|nd|rd|th)\b/i,
  /\b(i'?ll|i will)\s+be\s+there\b/i,

  // Apologising, promising, committing to do something.
  /(?<!\w)(sorry|apolog(y|ise|ize)|desculpa?e?|perd[ãa]o|me desculpe)(?!\w)/i,
  /\b(i promise|you have my word|prometo|dou minha palavra|garanto)\b/i,
  /\b(i'?ll|i will|vou|farei|mando|envio|entrego)\b[^.!?]{0,30}(?<!\w)(tomorrow|today|tonight|amanh[ãa]|hoje|friday|sexta|monday|segunda)(?!\w)/i,
];

/**
 * Whether this text is the user's to word.
 *
 * Exported so the judgement can be tested directly rather than only through the
 * policy — the interesting failures are all about which sentences match.
 */
export function commitsTheUser(text: unknown): boolean {
  if (typeof text !== "string") return true;
  const body = text.trim();
  if (!body) return true;
  if (body.length > SUBSTANTIAL_CHARS) return true;

  return COMMITMENTS.some((pattern) => pattern.test(body));
}

/**
 * The policy eve calls before `whatsapp_send_message` and `whatsapp_send_voice`
 * run.
 *
 * `not-applicable` means "no approval needed from me", not "approved" — the
 * bridge's allowlist still has to agree, and it is the thing that actually
 * refuses. This only decides whether a human sees the words first.
 *
 * ── The failure this signature exists for ───────────────────────────────────
 * It read `toolInput.message` only. `whatsapp_send_message` calls its field
 * `message`; `whatsapp_send_voice` calls its field `text`. So every voice note
 * handed this policy an `undefined`, `commitsTheUser` failed closed on a
 * non-string exactly as it is written to, and the answer was ALWAYS
 * `user-approval` — including for a note to the user's own chat, which reaches
 * nobody and can commit no one.
 *
 * eve parks a turn awaiting approval, and the WhatsApp console has no way to
 * present or answer one. So the turn ended with no words, no tool result and no
 * error: "Send me a good morning voice note" produced silence, twice, on two
 * different models, while "hello" in the same session answered in 1.9s. A
 * field-name mismatch is not usually a silent, total feature outage; it is one
 * when the thing it misreads fails closed and the gate it opens has no door.
 *
 * ── Why an empty recipient needs no approval ────────────────────────────────
 * The same reason `imageSendApproval` gives: the user's own chat reaches nobody.
 * A voice note with no `to` is the user hearing their own words before anyone
 * else does, which is the step approval exists to create — asking them to
 * approve it is asking them to approve listening to themselves.
 *
 * `whatsapp_send_message` is unaffected by that branch: its `to` is required, so
 * it never arrives here without one.
 */
export function sendApproval(
  input: { toolInput?: { to?: unknown; message?: unknown; text?: unknown } } = {},
): ApprovalDecision {
  // Whichever field this tool names its words. Read together rather than by
  // tool, so a third sender inherits the gate instead of slipping past it.
  const body = input.toolInput?.message ?? input.toolInput?.text;
  const hasWords = typeof body === "string" && body.trim() !== "";

  const to = input.toolInput?.to;
  const addressed = typeof to === "string" && to.trim() !== "";

  // No recipient AND no words is not a self-send, it is a malformed call. The
  // absence of a recipient only means "my own chat" on a request that is
  // otherwise complete; on one that is not, it means nothing is known about
  // where this is going, which is the case to ask about.
  if (!addressed) return hasWords ? "not-applicable" : "user-approval";

  return commitsTheUser(body) ? "user-approval" : "not-applicable";
}

/**
 * The policy for putting a GENERATED image in front of another person.
 *
 * It asks on the recipient rather than on the content, and that is the whole
 * difference from `sendApproval`. There is no text to read for a commitment
 * here: the payload is a picture a model invented, and the failure it can cause
 * is not a promise the user did not make but a picture they never saw. A
 * spelling error in a poster, a face that resembles someone, a detail nobody
 * asked for — none of it is inspectable by a regular expression, and all of it
 * is unrecallable once it is on a third party's phone.
 *
 * So: the user's own chat goes without asking, because it reaches nobody. Every
 * other recipient costs one tap.
 */
export function imageSendApproval(input: { toolInput?: { to?: unknown } } = {}): ApprovalDecision {
  const to = input.toolInput?.to;
  return typeof to === "string" && to.trim() ? "user-approval" : "not-applicable";
}
