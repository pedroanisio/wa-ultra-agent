import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * Put names to the chats that arrived without one.
 *
 * whatsmeow fills its LID cache on first use, and a cache filled seconds after
 * pairing is filled empty — so early messages land under a provisional `pn:`
 * digest instead of the durable key their sender's later messages carry. The
 * archive holds both and refuses to merge them on a self-asserted display name,
 * which is correct and also means the operator sees two half-chats.
 *
 * This asks the bridge to look again now that the cache is warm. It is a read of
 * the contact store and a rename in SQLite: no message is sent, and nothing about
 * the correspondence changes but its label.
 */
export default defineTool({
  description:
    "Re-resolve the chats that are still filed under a provisional key instead of a person's name — " +
    "the ones that show as a long `pn:` or `@lid` string. Names arrive late on this protocol, so a chat " +
    "read early after pairing can be nameless while the same person's later messages are not. Run this " +
    "when the user asks who an unnamed chat is, or when `whatsapp_status` reports provisional chats. " +
    "It sends nothing and only relabels what is already stored.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    try {
      const result = await bridge.refreshNames(ctx.abortSignal);
      return { ok: true as const, updated: result.updated, remaining: result.remaining ?? 0 };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, error: error.message };
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      return { type: "text" as const, value: `Names could not be refreshed: ${output.error}` };
    }
    if (output.updated === 0) {
      return {
        type: "text" as const,
        value:
          "Nothing could be renamed. The remaining chats have no name the contact store knows — say " +
          "that plainly rather than guessing who they are from what they said.",
      };
    }
    return {
      type: "text" as const,
      value:
        `${output.updated} chat${output.updated === 1 ? "" : "s"} now carry a name; ` +
        `${output.remaining} still do not.`,
    };
  },
});
