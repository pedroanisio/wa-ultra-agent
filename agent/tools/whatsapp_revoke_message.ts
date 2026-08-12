import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * Delete a message for everyone.
 *
 * The only undo this system has, and it is a loud one: WhatsApp leaves "This
 * message was deleted" where the message was, so everybody who was there knows
 * something was taken back. That is worth doing for a message sent to the wrong
 * person and rarely worth doing for a message somebody merely regrets.
 *
 * Deliberately not gated behind an approval policy. Approval exists to slow down
 * saying something; this is the tool for having already said it, and a
 * confirmation step here is a step during which more people read it.
 */
export default defineTool({
  description:
    "Delete one message for everyone in the chat ('delete for everyone'). WhatsApp replaces it with " +
    "'This message was deleted', which every participant can see — so this undoes the content, not the " +
    "fact that something was sent. Use it when a message went to the wrong chat or contained something " +
    "it should not have. Only works on this account's own messages, and only within WhatsApp's time " +
    "limit. Take `messageId` from the message's `key` in the archive.",
  inputSchema: z.object({
    to: z.string().min(1).describe("The chat the message is in, by name."),
    messageId: z.string().min(1).describe("The message's `key` in the archive."),
    sender: z
      .string()
      .optional()
      .describe("In a group, who sent the message. Omit in a one-to-one chat."),
  }),
  async execute({ to, messageId, sender }, ctx) {
    if (!to.trim()) return { ok: false as const, error: "A chat is required." };

    try {
      const result = await bridge.revokeMessage({ to, messageId, sender }, ctx.abortSignal);
      return { ok: true as const, id: result.id, messageId };
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
          `The message was NOT deleted: ${output.error}\n\n` +
          "Tell the user immediately and plainly — a delete they believe happened and did not is worse " +
          "than one that never started.",
      };
    }
    return {
      type: "text" as const,
      value:
        "Deleted for everyone. The chat now shows 'This message was deleted' in its place, which the " +
        "other side can see — say that, so the user is not surprised by it.",
    };
  },
});
