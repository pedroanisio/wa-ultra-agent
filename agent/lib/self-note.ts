/**
 * Composing a self-note.
 *
 * A self-note is what the user reads on their phone and copies into a real
 * conversation. WhatsApp's long-press → Copy takes a *whole message*, so the
 * body has to arrive alone in its own message: no label, no quote marks, no
 * "here's your draft", no signature. Anything else and every paste needs
 * hand-cleanup on a phone keyboard, which is the entire feature undone.
 *
 * That is why context is a separate, preceding message rather than a header
 * line — and why nothing here ever modifies the body beyond trimming it.
 */

export type SelfNoteKind = "draft" | "digest" | "extract" | "transcript" | "reminder" | "note";

/** Matches the bridge's per-message ceiling. */
export const MAX_BODY_CHARS = 4000;

const LABEL: Record<SelfNoteKind, string> = {
  draft: "Draft",
  digest: "Digest",
  extract: "Extracted",
  transcript: "Transcript",
  reminder: "Reminder",
  note: "Note",
};

export interface SelfNoteInput {
  /** The copy-paste-ready text. Sent verbatim, alone in its own message. */
  body: string;
  /** Optional preceding line: who it is for, why it exists. */
  context?: string;
  kind?: SelfNoteKind;
}

/**
 * Turn a note into the one or two messages the bridge should write.
 *
 * Returns `[body]`, or `[context, body]` — body always last, always untouched.
 */
export function composeSelfNote({ body, context, kind = "note" }: SelfNoteInput): string[] {
  const text = (body ?? "").trim();
  if (!text) throw new Error("A self-note needs a body: the text you will copy and paste.");
  if (text.length > MAX_BODY_CHARS) {
    throw new Error(`The body is ${text.length} characters; the limit is ${MAX_BODY_CHARS}.`);
  }

  const note = (context ?? "").trim();
  // A blank context is absent, not an empty line. Sending one would cost a whole
  // browser interaction to deliver nothing.
  if (!note) return [text];

  const header = `${LABEL[kind]} · ${note}`;
  if (header.length > MAX_BODY_CHARS) {
    throw new Error(
      `The context line is ${header.length} characters; the limit is ${MAX_BODY_CHARS}. ` +
        "Keep it to one line — it exists to say who the note is for.",
    );
  }

  return [header, text];
}
