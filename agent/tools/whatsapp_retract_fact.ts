import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * Withdraw something the archive believes.
 *
 * ── Why this tool has to exist ──────────────────────────────────────────────
 * `whatsapp_remember_fact` refuses a claim that cites no message, and the store
 * enforces that with a foreign key. That is the strongest anti-hallucination
 * measure here and it is genuinely good — but it proves **traceability, not
 * truth**. Anyone in any group chat can write a false statement, and a false
 * statement that really is in the archive satisfies every check the store makes.
 * It then reads back as a *cited* fact with a receipt, which is more persuasive
 * than an uncited one, not less.
 *
 * The corpus names the untreated version of this "memory poisoning", and names
 * the property that makes it dangerous: long-term behavioural shifts that are
 * "difficult to detect and reverse". The citation is what makes it detectable.
 * This is what makes it reversible. Without both, the archive can only accumulate.
 *
 * ── Why a reason is required and the row is kept ────────────────────────────
 * Retraction is a tombstone, not a delete. Recall stops returning the fact
 * immediately, which is the point; the row stays because "why did I think the
 * meeting was at 14:00?" is asked *after* the belief turns out to be wrong, and
 * deleting the row makes exactly that question unanswerable. The reason is
 * mandatory so a deliberate correction can be told apart later from a mistake.
 */
export default defineTool({
  description:
    "Withdraw a stored fact that is wrong, out of date, or was never what the cited message " +
    "actually said. Use it when the user corrects something you told them, when a fact is " +
    "contradicted by a later message, or when you notice a fact rests on a message that does not " +
    "support it.\n\n" +
    "A `reason` is required — say which of those it is, briefly. The fact stops being recalled " +
    "immediately, but the record that it was once believed is kept, so a past answer can still be " +
    "explained. Pass `restore: true` to undo a retraction you made in error.\n\n" +
    "Get the `id` from whatsapp_person, which lists each fact with its id and the message it cites. " +
    "Do NOT retract a fact merely because it is unflattering or because someone in a chat disputes " +
    "it — a fact is retracted when it misrepresents what was said or is no longer true, not when it " +
    "is inconvenient.",
  inputSchema: z.object({
    id: z.number().int().describe("The fact's id, as shown by whatsapp_person."),
    reason: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Why it is being withdrawn: 'wrong', 'out of date', 'not what the message said', or the " +
          "correction the user gave. Required unless restoring.",
      ),
    restore: z.boolean().default(false).describe("Undo a retraction instead of making one."),
  }),
  async execute({ id, reason, restore }, ctx) {
    if (!restore && !String(reason ?? "").trim()) {
      return {
        ok: false as const,
        error:
          "A reason is required to retract a fact. A fact withdrawn silently cannot be told apart " +
          "later from one withdrawn by mistake.",
      };
    }
    try {
      // Normalised rather than spread from the ternary: restore and retract
      // return different shapes, and a union of the two makes the retract-only
      // fields unreachable in toModelOutput.
      if (restore) {
        const result = await bridge.restoreFact({ id }, ctx.abortSignal);
        return {
          ok: true as const,
          restore: true,
          reason,
          id: result.id,
          retracted: result.retracted,
          at: undefined as string | undefined,
          alreadyRetracted: false,
        };
      }
      const result = await bridge.retractFact(
        { id, reason: String(reason).trim() },
        ctx.abortSignal,
      );
      return {
        ok: true as const,
        restore: false,
        reason,
        id: result.id,
        retracted: result.retracted,
        at: result.at,
        alreadyRetracted: Boolean(result.alreadyRetracted),
      };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, error: error.message };
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      return { type: "text" as const, value: `Could not change that fact: ${output.error}` };
    }
    if (output.restore) {
      return {
        type: "text" as const,
        value: `Fact ${output.id} is in use again. Tell the user it is back, in case the retraction was theirs.`,
      };
    }
    if (output.alreadyRetracted) {
      return {
        type: "text" as const,
        value:
          `Fact ${output.id} was already withdrawn (at ${output.at}). Nothing changed — say so ` +
          "rather than implying you have just fixed it.",
      };
    }
    return {
      type: "text" as const,
      value:
        `Fact ${output.id} withdrawn: ${output.reason}. It will not be recalled again. The record ` +
        "that it was once believed is kept, so a past answer that relied on it can still be " +
        "explained. Say what you removed and why — a memory that changes silently is worse than " +
        "one that was wrong.",
    };
  },
});
