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
    mode: z
      .enum(["top-up", "backfill"])
      .default("top-up")
      .describe(
        "`top-up` for recent messages since the last run; `backfill` to reach genuinely old history.",
      ),
    maxScrolls: z
      .number()
      .int()
      .min(0)
      .max(15)
      .default(5)
      .describe("How many screenfuls to walk back in this call. Each one costs an interaction."),
  }),
  async execute({ chat, mode, maxScrolls }, ctx) {
    try {
      const result = await bridge.ingest({ chat, mode, maxScrolls }, ctx.abortSignal);
      return { ok: true as const, ...result };
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

    const reach = output.bounds.oldestAt
      ? ` The archive for this chat now reaches back to ${output.bounds.oldestAt.slice(0, 10)} (${output.bounds.count} messages).`
      : "";

    const next = output.atTop
      ? " The whole conversation has been read; there is nothing older."
      : output.reachedKnown
        ? " It stopped at messages already saved, so this chat is up to date."
        : output.budgetExhausted
          ? " It stopped early because the hourly interaction budget ran out — resume later, not now."
          : " More history remains; run it again to continue.";

    return {
      type: "text" as const,
      value:
        `Saved ${output.inserted} new message${output.inserted === 1 ? "" : "s"} from "${output.chat}" ` +
        `(${output.duplicates} already known, ${output.scrolls} scrolls).${reach}${next}`,
    };
  },
});
