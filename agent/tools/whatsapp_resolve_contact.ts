import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * Who does this name refer to?
 *
 * WhatsApp's own search ranks by recency, which is how "Helena Braga" opens a
 * group called "We" — she is its most recent sender. This resolves against the
 * archive's roster by name similarity instead, and reports ambiguity rather than
 * picking. A wrong recipient cannot be recalled, so asking is always cheaper
 * than guessing.
 */
export default defineTool({
  description:
    "Work out which conversation a name refers to before using it. Returns the exact chat name when " +
    "there is one clear answer, or the candidates when there is not. Use it whenever the user names " +
    "someone loosely — a first name, a nickname, a partial name — and especially before sending. " +
    "If `ambiguous` is true, ask the user which one they mean; do NOT pick. If `name` comes back, " +
    "use that exact string as the `to` of a send. Resolution covers chats that have been archived, " +
    "plus any aliases; an unknown name may simply never have been archived.",
  inputSchema: z.object({
    name: z.string().min(1).describe("The name, nickname or partial name the user said."),
  }),
  async execute({ name }, ctx) {
    try {
      const result = await bridge.resolveContact(name, ctx.abortSignal);
      return { ok: true as const, query: name, ...result };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, error: error.message };
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) return { type: "text" as const, value: `Could not resolve that name: ${output.error}` };

    if (output.ambiguous) {
      const names = output.candidates.map((c) => `"${c.name}"`).join(", ");
      return {
        type: "text" as const,
        value:
          `"${output.query}" matches several chats equally well: ${names}. Ask the user which one ` +
          "they mean and use their answer verbatim. Do not choose for them.",
      };
    }

    if (!output.name) {
      return {
        type: "text" as const,
        value:
          `Nothing in the archive matches "${output.query}". ${output.reason || ""} It may simply ` +
          "not have been archived yet — say so rather than assuming the person does not exist.",
      };
    }

    return {
      type: "text" as const,
      value: output.exact
        ? `"${output.query}" is "${output.name}"${output.via === "alias" ? " (a known alias)" : ""}. Use that exact name.`
        : `"${output.query}" most likely means "${output.name}" — the only chat whose name contains ` +
          "every word you gave. Use that exact name, and say which conversation you used.",
    };
  },
});
