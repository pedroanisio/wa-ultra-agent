import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * What is owed, in both directions.
 *
 * The two halves are kept apart deliberately. What the user promised and what
 * other people owe them are different lists needing different actions — one is
 * work to do, the other is a follow-up to send — and merging them produces a
 * backlog that reads as failure while hiding the things that are someone else's
 * move.
 *
 * Everything here comes from `whatsapp_extract_actions`, so every row carries
 * the message it was drawn from. Cite it rather than asserting the obligation.
 */
export default defineTool({
  description:
    "List obligations recorded from conversations: what the user promised (`commitment`), what they " +
    "were asked to do (`request`), what other people owe them (`waiting`), and questions asked of " +
    "them that were never answered (`question`). This is what answers 'what do I owe people' and " +
    "'what am I waiting on'. Pass `overdue: true` for anything past its stated date. Every item " +
    "includes the message it came from — say who said it and when, rather than stating the " +
    "obligation flatly. Items only exist for chats that have been through whatsapp_extract_actions; " +
    "an empty list may mean nothing was recorded yet, not that nothing is owed.",
  inputSchema: z.object({
    type: z
      .enum(["commitment", "waiting", "request", "question", "deadline", "decision", "event"])
      .optional()
      .describe("Restrict to one kind. `commitment` is what the user owes; `waiting` is what they are owed."),
    chat: z.string().optional().describe("Restrict to obligations from one conversation."),
    overdue: z.boolean().optional().describe("Only items whose stated date has already passed."),
    dueBefore: z.string().optional().describe("ISO date — only items due before it."),
    status: z
      .enum(["open", "done", "dropped"])
      .default("open")
      .describe("`open` is what still needs attention."),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  async execute({ type, chat, overdue, dueBefore, status, limit }, ctx) {
    try {
      const result = await bridge.listExtractions(
        { type, chat, overdue, dueBefore, status, limit },
        ctx.abortSignal,
      );
      return { ok: true as const, items: result.items, filters: { type, chat, overdue, status } };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, error: error.message };
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      return { type: "text" as const, value: `Could not read obligations: ${output.error}` };
    }

    if (output.items.length === 0) {
      return {
        type: "text" as const,
        value:
          "Nothing recorded matching that. Note this only covers conversations already processed " +
          "with whatsapp_extract_actions — say so rather than reporting that nothing is owed.",
      };
    }

    const lines = output.items.map(
      (i) =>
        `- #${i.id} [${i.type}] ${i.statement}` +
        `${i.due_at ? ` — due ${i.due_at}` : ""}` +
        `\n    from ${i.source_sender || "unknown"} in "${i.source_chat}" ${i.source_sent_at || ""}: ` +
        `"${i.source_text.slice(0, 160)}"`,
    );

    return {
      type: "text" as const,
      value:
        `${output.items.length} open item${output.items.length === 1 ? "" : "s"}. Each shows the ` +
        `message it came from — quote that when you report it. Use the #id with ` +
        `whatsapp_resolve_obligation when the user says one is handled.\n\n${lines.join("\n")}`,
    };
  },
});
