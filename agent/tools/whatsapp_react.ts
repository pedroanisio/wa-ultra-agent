import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * React to a message.
 *
 * The cheapest thing this agent can say, and often the most appropriate: an
 * acknowledgement that costs the reader nothing to receive and cannot be
 * misread as a commitment. It needs no approval gate for that reason — a 👍
 * agrees to nothing that a person could be held to.
 */
export default defineTool({
  description:
    "React to one WhatsApp message with an emoji, as the user. Use it to acknowledge something that " +
    "needs no reply — 'got it', 'thanks', 'yes' — instead of sending a message that demands one back. " +
    "It addresses one exact message by its `messageId`, which you take from a message in the archive " +
    "(its `key`), never from memory. Pass an empty `emoji` to take back a reaction already given.",
  inputSchema: z.object({
    to: z.string().min(1).describe("The chat the message is in, by name."),
    messageId: z
      .string()
      .min(1)
      .describe("The message's `key` as stored in the archive — the protocol's own id for it."),
    emoji: z
      .string()
      .describe("A single emoji. Empty removes a reaction this account gave earlier."),
    sender: z
      .string()
      .optional()
      .describe("In a group, who wrote the message being reacted to. Omit in a one-to-one chat."),
  }),
  async execute({ to, messageId, emoji, sender }, ctx) {
    if (!to.trim()) return { ok: false as const, error: "A chat is required." };

    try {
      const result = await bridge.react({ to, messageId, emoji, sender }, ctx.abortSignal);
      return { ok: true as const, id: result.id, emoji, messageId };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, error: error.message };
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      return { type: "text" as const, value: `The reaction was NOT sent: ${output.error}` };
    }
    return {
      type: "text" as const,
      value: output.emoji
        ? `Reacted ${output.emoji}. It is on the message now; say so in a few words at most.`
        : "The reaction was removed.",
    };
  },
});
