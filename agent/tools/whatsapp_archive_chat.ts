import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * Read further back than one screenful, and keep what is found.
 *
 * The conversation pane virtualises, so history only exists once it has been
 * scrolled into view. This walks a chat backwards and writes each window to the
 * archive, which is what later makes searching older messages possible at all.
 *
 * Bounded by design: every scroll spends from the bridge's interaction budget,
 * because a backfill running at machine speed is exactly the traffic pattern
 * that gets a personal WhatsApp account banned. Run it again to continue.
 */
export default defineTool({
  description:
    "Read further back in a WhatsApp conversation than the visible tail, and save what is found so it " +
    "can be searched later with whatsapp_search_archive. Two modes: `top-up` (default) stops as soon " +
    "as it recognises a message already saved — use it to catch up a chat cheaply; `backfill` keeps " +
    "going into older history it has never seen. Each call does a bounded amount of work and returns " +
    "`hasMore`: call it again to continue, and stop when `hasMore` is false. Re-running it is free — " +
    "messages already saved are recognised and skipped. If `budgetExhausted` comes back true, the " +
    "bridge's hourly interaction limit was reached: tell the user to retry later and DO NOT loop.",
  inputSchema: z.object({
    chat: z.string().min(1).describe("Conversation name. Prefer one taken from whatsapp_list_chats."),
    oldestId: z
      .string()
      .optional()
      .describe("The `key` of the oldest message you already hold, from whatsapp_read_chat."),
    oldestTimestamp: z
      .number()
      .int()
      .optional()
      .describe("That message's unix timestamp, if known. Anchors the request."),
    count: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("How many messages to ask the phone for."),
  }),
  async execute({ chat, oldestId, oldestTimestamp, count }, ctx) {
    try {
      // A request to the PHONE, not a scroll of a rendered pane. Whatever it
      // returns arrives through the transport and lands in the archive on the
      // next drain, so this call reports that the ask was made, not what came.
      const result = await bridge.requestHistory(
        { chat, oldestId, oldestTimestamp, count },
        ctx.abortSignal,
      );
      return { ok: true as const, chat, ...result };
    } catch (error) {
      if (error instanceof BridgeError) {
        return { ok: false as const, error: error.message, rateLimited: error.status === 429 };
      }
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      return {
        type: "text" as const,
        value: output.rateLimited
          ? `${output.error}\n\nStop here and tell the user. Do not retry in a loop.`
          : `Could not read back through that chat: ${output.error}`,
      };
    }

    // Deliberately says only that the ask was made. The phone answers over the
    // protocol and the messages land in the archive on the next drain, so a
    // count here would be invented — and "how much came back" is a question for
    // whatsapp_read_chat a moment later, not for this call.
    return {
      type: "text" as const,
      value:
        `Asked your phone for older messages in "${output.chat}". ` +
        "They arrive over the protocol and land in the archive within a few seconds — " +
        "read the chat again to see them. Reachable depth is whatever the phone still " +
        "holds, so a short answer is a fact about the phone, not a failure.",
    };
  },
});
