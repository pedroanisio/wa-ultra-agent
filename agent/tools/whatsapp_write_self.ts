import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";
import { MAX_BODY_CHARS, composeSelfNote } from "../lib/self-note.ts";

/**
 * Write to the user's own WhatsApp chat.
 *
 * This is the safe half of sending, and it needs no confirmation step. The
 * recipient is a constant, so the wrong-recipient accident that `send_prepare`
 * and `send_commit` exist to prevent cannot happen here, and the decision to
 * actually send something to another person stays on the user's phone — they
 * copy the text and paste it themselves.
 *
 * That makes this the right default for anything the agent produces: a drafted
 * reply, a summary, a transcript, a reminder. Prefer it to asking for approval
 * to send.
 */
export default defineTool({
  description:
    "Write a note to the USER'S OWN WhatsApp chat, so it appears on their phone where they can read " +
    "it, copy it, and paste it into a real conversation themselves. Nothing is sent to anyone else, " +
    "so no approval is needed — use it freely. This is the preferred way to deliver a drafted reply, " +
    "a summary, a transcript, or a reminder. The `body` is what the user will copy, so write it as " +
    "the finished text and nothing else: no preamble, no quote marks, no 'here is your draft', no " +
    "signature. Put anything explanatory in `context`, which is delivered as a separate line above it.",
  inputSchema: z.object({
    body: z
      .string()
      .min(1)
      .max(MAX_BODY_CHARS)
      .describe(
        "The copy-paste-ready text, delivered alone in its own WhatsApp message. For a draft reply, " +
          "this is the message itself, in the user's voice and in the language of the conversation " +
          "it is meant for.",
      ),
    context: z
      .string()
      .max(300)
      .optional()
      .describe(
        "One short line saying who the note is for and why, delivered as a separate message above " +
          "the body. Omit it when the body speaks for itself — it costs an extra message.",
      ),
    kind: z
      .enum(["draft", "digest", "extract", "transcript", "reminder", "note"])
      .default("note")
      .describe("Labels the context line so the user can scan it on a phone. Ignored when there is no context."),
  }),
  async execute({ body, context, kind }, ctx) {
    let messages: string[];
    try {
      messages = composeSelfNote({ body, context, kind });
    } catch (error) {
      return { ok: false as const, written: false, error: (error as Error).message };
    }

    try {
      const result = await bridge.writeSelf(messages, ctx.abortSignal);
      return { ok: true as const, written: true, ...result };
    } catch (error) {
      if (error instanceof BridgeError) {
        return { ok: false as const, written: false, error: error.message };
      }
      throw error;
    }
  },

  /**
   * The model needs to know whether the note landed and where, so it can tell
   * the user to look at their phone. It does not need the text echoed back — it
   * just wrote it.
   */
  toModelOutput(output) {
    if (!output.ok) {
      return {
        type: "text" as const,
        value: `The note was NOT written: ${output.error}\n\nTell the user plainly; do not retry blindly.`,
      };
    }

    const count = output.messages.length;
    return {
      type: "text" as const,
      value:
        `Written to "${output.chat}" as ${count} message${count === 1 ? "" : "s"}. ` +
        "It is on the user's phone now — they can copy the last message and paste it wherever they want.",
    };
  },
});
