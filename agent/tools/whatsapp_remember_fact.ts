import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * Write something down about a person or a project — with its receipt.
 *
 * This is the smallest honest version of the memory layer. What makes it worth
 * having is not the storage, which is trivial, but the citation: every fact
 * carries the key of the message that says it, the store enforces that with a
 * foreign key, and so the belief can always be traced back to the sentence that
 * caused it.
 *
 * That is also why there is no way to record a fact the agent merely inferred.
 * "Helena seems stressed about the move" has nothing to cite and is refused,
 * which is the point: an archive that accumulates impressions becomes a set of
 * claims nobody can check, and it is the user's life being described.
 */
export default defineTool({
  description:
    "Remember a durable fact about a person or project, citing the message that establishes it. " +
    "Use it for things that stay true and are expensive to re-derive — 'Fabio's daughter is called " +
    "Alice', 'the apartment handover is with Antonio', 'Helena prefers WhatsApp to email'. Do NOT " +
    "use it for obligations: those come from whatsapp_extract_actions, which records them with the " +
    "same provenance. `sourceMessageKey` must be a `key` you actually saw in a result from " +
    "whatsapp_search_archive, whatsapp_get_context or whatsapp_obligations — inventing one is " +
    "refused, and a fact you inferred rather than read has nothing to cite and should not be " +
    "stored at all. Recall them with whatsapp_person.",
  inputSchema: z.object({
    statement: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "The fact, as one short sentence, in the language it was said in. Write what is true, not " +
          "what was said — 'Fabio's daughter is called Alice', not 'Fabio mentioned Alice'.",
      ),
    subject: z
      .string()
      .optional()
      .describe(
        "Who or what the fact is about, as the exact chat name from whatsapp_list_chats or " +
          "whatsapp_person. This is how it is found again, so a nickname here loses it.",
      ),
    sourceMessageKey: z
      .string()
      .min(1)
      .describe("The `key` of the message this comes from, copied verbatim from a tool result."),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("How sure the message makes you. Below 0.5, prefer not storing it at all."),
  }),
  async execute({ statement, subject, sourceMessageKey, confidence }, ctx) {
    try {
      const result = await bridge.saveFact(
        { statement, subject, sourceMessageKey, confidence },
        ctx.abortSignal,
      );
      return { ok: true as const, ...result, statement };
    } catch (error) {
      if (error instanceof BridgeError) {
        return {
          ok: false as const,
          error: error.message,
          // 409 is the provenance rule, not a fault: the cited message is not
          // in the archive, so there is nothing for the fact to hang off.
          uncitable: error.status === 409,
        };
      }
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      return {
        type: "text" as const,
        value: output.uncitable
          ? `Not stored: ${output.error}\n\nThe message must be archived first with ` +
            "whatsapp_archive_chat. Do not retry with a different key to get around this."
          : `Not stored: ${output.error}`,
      };
    }

    return {
      type: "text" as const,
      value:
        `Remembered${output.subject ? ` about "${output.subject}"` : ""}: "${output.statement}" ` +
        `— cited to message ${output.sourceMessageKey}. It will come back from whatsapp_person.`,
    };
  },
});
