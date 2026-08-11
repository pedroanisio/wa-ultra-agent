import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * The user's answer to a proposed move.
 *
 * This is the half of the loop that makes the other half tolerable. Without it,
 * every pass re-proposes what was already turned down, and an assistant that
 * cannot remember a "no" is one the user has to argue with every morning.
 *
 * `dismissed` is stronger than it looks: the store keeps the status through a
 * re-proposal, and `normalizeProposals` drops any move whose identity matches a
 * dismissed one, so a refusal is enforced twice — once where the suggestion is
 * generated and once where it would be stored.
 *
 * `accepted` records that the user acted on it. It sends nothing: acting on a
 * draft still means `whatsapp_send_message`, behind the allowlist, or
 * `whatsapp_write_self` when the wording is theirs.
 */
export default defineTool({
  description:
    "Record what the user decided about a proposed next move: accepted (they acted on it, or asked " +
    "for it to be sent), dismissed (they said no — never suggest it again), or expired (it stopped " +
    "being relevant). Sends nothing itself. Call it whenever the user reacts to a proposal from " +
    "whatsapp_next_best, and especially when they turn one down: a dismissal is what stops the same " +
    "suggestion coming back. The id comes from a whatsapp_next_best or whatsapp_twin result.",
  inputSchema: z.object({
    id: z.number().int().describe("The proposal's id."),
    status: z
      .enum(["accepted", "dismissed", "expired"])
      .describe("What the user decided. `dismissed` is permanent — it suppresses re-proposal."),
  }),
  async execute({ id, status }, ctx) {
    try {
      const result = await bridge.resolveProposal({ id, status }, ctx.abortSignal);
      return { ok: true as const, ...result };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, error: error.message };
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      return { type: "text" as const, value: `That proposal was not updated: ${output.error}` };
    }
    return {
      type: "text" as const,
      value:
        output.status === "dismissed"
          ? `Proposal ${output.id} is dismissed. It will not be suggested again.`
          : `Proposal ${output.id} is marked ${output.status}. Nothing was sent by this call.`,
    };
  },
});
