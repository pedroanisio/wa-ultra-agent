import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * Edit a message this account already sent.
 *
 * WhatsApp shows an edited message as edited, to everybody. That makes this a
 * correction, not a rewrite of history — and it is the reason it is worth having
 * rather than sending "* tomorrow" as a second message, which every reader then
 * has to reconcile with the first.
 */
export default defineTool({
  description:
    "Correct a message this account already sent, replacing its text. WhatsApp marks the message as " +
    "edited for everyone who can see it, so this fixes a mistake — it does not hide one. Only messages " +
    "the user sent can be edited, and only for a limited window after sending. Use the message's `key` " +
    "from the archive as `messageId`. Prefer this to sending a correction as a second message.",
  inputSchema: z.object({
    to: z.string().min(1).describe("The chat the message is in, by name."),
    messageId: z.string().min(1).describe("The message's `key` in the archive."),
    message: z.string().min(1).max(4000).describe("The corrected text, in full — it replaces the original."),
  }),
  async execute({ to, messageId, message }, ctx) {
    if (!to.trim()) return { ok: false as const, error: "A chat is required." };

    try {
      const result = await bridge.editMessage({ to, messageId, message }, ctx.abortSignal);
      return { ok: true as const, id: result.id, messageId, message };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, error: error.message };
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      return {
        type: "text" as const,
        value:
          `The edit did NOT go through: ${output.error}\n\n` +
          "WhatsApp only allows editing your own messages, and only for a while after sending. " +
          "If that window has passed, say so — do not send the correction as a new message unless asked.",
      };
    }
    return {
      type: "text" as const,
      value: "The message now reads as corrected, and shows as edited to everyone in that chat.",
    };
  },
});
