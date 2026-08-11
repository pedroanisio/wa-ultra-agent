import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * "What needs my attention?"
 *
 * The question the whole system exists to answer, and the one that makes an
 * agent useful daily rather than merely impressive. Four buckets, kept apart:
 * what is late, what is coming, what someone else owes, and what was asked and
 * never answered.
 *
 * Assembled from the archive, so it costs nothing and cannot be rate-limited.
 * A quiet day returns `total: 0`, and a quiet day should produce silence rather
 * than a message saying there is nothing to say.
 */
export default defineTool({
  description:
    "Assemble everything currently needing the user's attention: obligations past their date, ones " +
    "coming up, what other people owe them, and questions asked of them that are still unanswered. " +
    "This is the tool for 'what needs my attention', 'what's on my plate', or a daily catch-up. " +
    "`total: 0` means there is genuinely nothing — say so briefly, or say nothing at all if this " +
    "is a scheduled run. Every item carries the message it came from; cite it. Coverage is limited " +
    "to conversations already processed with whatsapp_extract_actions.",
  inputSchema: z.object({
    horizonDays: z
      .number()
      .int()
      .min(1)
      .max(60)
      .default(7)
      .describe("How far ahead counts as 'coming up'."),
  }),
  async execute({ horizonDays }, ctx) {
    try {
      const digest = await bridge.attention({ horizonDays }, ctx.abortSignal);
      return { ok: true as const, ...digest };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, error: error.message };
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      return { type: "text" as const, value: `Could not assemble the digest: ${output.error}` };
    }

    if (output.total === 0) {
      return {
        type: "text" as const,
        value:
          "Nothing needs attention: no overdue items, nothing due soon, nobody owing anything, no " +
          "unanswered questions. If this was a scheduled run, send nothing at all.",
      };
    }

    const section = (title: string, items: typeof output.overdue) =>
      items.length
        ? `${title}\n` +
          items
            .map(
              (i) =>
                `- ${i.statement}${i.due_at ? ` (due ${i.due_at})` : ""} — ` +
                `${i.source_sender || "unknown"} in "${i.source_chat}"`,
            )
            .join("\n")
        : "";

    const body = [
      section("OVERDUE", output.overdue),
      section(`DUE WITHIN ${output.horizonDays} DAYS`, output.dueSoon),
      section("WAITING ON OTHERS", output.waitingOn),
      section("UNANSWERED QUESTIONS", output.unanswered),
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      type: "text" as const,
      value:
        `As of ${output.asOf} — ${output.total} item${output.total === 1 ? "" : "s"}. Lead with ` +
        `what is late and what is someone else's move; keep it short enough to read on a phone.` +
        `\n\n${body}`,
    };
  },
});
