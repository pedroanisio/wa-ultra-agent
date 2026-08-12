import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * Teach the agent a nickname.
 *
 * People do not call each other by their contact-card names — "tonhão" is
 * Antonio Carlos Moreira da Fonseca. Without a mapping the request fails twice
 * over: the chat search does not match a nickname, and the requested-versus-
 * resolved guard refuses the result even when it does.
 *
 * An alias is a lookup convenience, never a permission. The name it produces
 * still has to pass the send allowlist — verified: the allowlist check runs on
 * the chat that actually opened, so no alias can widen who may be messaged.
 *
 * ── Why origin is a required judgement and not a default ────────────────────
 * "Cannot widen the allowlist" is not the same as "trustworthy". An alias learned
 * from chat text is message content influencing which conversation gets opened,
 * one step removed — and the rule everywhere else in this system is that no
 * message content may select a recipient.
 *
 * That does not make a nickname read from a chat unusable; it makes it something
 * that has to be on the record. So the model states which of the two it is, and
 * "message" has to cite the message, exactly as `whatsapp_remember_fact` does.
 * The agent is the only thing that knows whether it was told or inferred, which
 * is precisely why this cannot be defaulted for it.
 */
export default defineTool({
  description:
    "Remember that a nickname refers to a particular conversation, so it resolves next time. Use it " +
    "when the user calls someone by a name the archive does not know — a nickname, a shortening, a " +
    "family word — so the next mention resolves without asking them again. " +
    "`canonical` must be the exact chat name. Set `forget: true` to remove one. This does NOT grant " +
    "permission to message anyone: the allowlist is unchanged.\n\n" +
    "You MUST say where the nickname came from. Use origin 'session' when the USER told you, in " +
    "this conversation — 'Pim is Helena', 'call her Helena from now on'. Use origin 'message' when " +
    "you worked it out from something written in a chat, and pass sourceMessageKey citing the " +
    "message that says so; without the citation it is refused. If you are unsure which applies, it " +
    "is 'message' — you inferred it. Do not guess 'session' to avoid needing a citation.",
  inputSchema: z.object({
    alias: z.string().min(1).describe("What the user calls them."),
    canonical: z
      .string()
      .optional()
      .describe("The exact chat name it refers to. Required unless forgetting."),
    forget: z.boolean().default(false).describe("Remove this alias instead of setting it."),
    origin: z
      .enum(["session", "message"])
      .default("session")
      .describe(
        "'session' when the user stated it while talking to you. 'message' when you read it out of " +
          "chat text, which then requires sourceMessageKey.",
      ),
    sourceMessageKey: z
      .string()
      .optional()
      .describe("The message that says so. Required when origin is 'message'."),
  }),
  async execute({ alias, canonical, forget, origin, sourceMessageKey }, ctx) {
    if (!forget && !canonical) {
      return { ok: false as const, error: "A chat name is required to remember an alias." };
    }
    // Caught here so the model gets a usable instruction rather than a 400 it has
    // to interpret. The bridge enforces the same rule regardless.
    if (!forget && origin === "message" && !sourceMessageKey) {
      return {
        ok: false as const,
        error:
          "An alias you worked out from chat text has to cite the message it came from. Pass " +
          "sourceMessageKey, or use origin 'session' if the user actually told you.",
      };
    }
    try {
      const result = await bridge.setAlias(
        { alias, canonical, forget, origin, sourceMessageKey },
        ctx.abortSignal,
      );
      return { ok: true as const, forget, origin, ...result };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, error: error.message };
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) return { type: "text" as const, value: `Could not save that: ${output.error}` };
    if (output.forget) {
      return { type: "text" as const, value: `Forgot the alias "${output.alias}".` };
    }
    return {
      type: "text" as const,
      value:
        `"${output.alias}" now resolves to "${output.canonical}".` +
        (output.origin === "message"
          ? " Recorded as read from a chat rather than stated by the user, with the message it came " +
            "from. Worth confirming with them, since you inferred it."
          : "") +
        " This is a lookup only — it does not permit messaging anyone.",
    };
  },
});
