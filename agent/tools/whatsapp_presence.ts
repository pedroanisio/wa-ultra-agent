import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * Typing and online indicators.
 *
 * The only tool here that changes how the account *looks* rather than what it
 * says. It earns its place because of the gap this agent introduces: a person
 * types for four seconds, and an agent that reads a chat, models it and drafts a
 * reply can take a minute. Without an indicator that minute reads as absence.
 *
 * It is also the tool most able to lie. `composing` when nothing is being
 * written is a false signal to a real person, so it belongs immediately before
 * an actual send, not sprinkled to seem attentive.
 */
export default defineTool({
  description:
    "Show a typing or online indicator in a chat. Send `composing` right before you send a message that " +
    "took a while to prepare, so the wait reads as thought rather than silence, and `paused` if you end " +
    "up not sending. Do NOT use it to appear busy: it is a signal a real person reads, and one that is " +
    "not followed by a message is a lie told in the user's name.",
  inputSchema: z.object({
    to: z.string().min(1).describe("The chat to show the indicator in, by name."),
    state: z
      .enum(["composing", "recording", "paused", "available", "unavailable"])
      .describe(
        "`composing` is 'typing…', `recording` is 'recording audio…', `paused` clears it. " +
          "`available`/`unavailable` set whether this account shows as online at all.",
      ),
  }),
  async execute({ to, state }, ctx) {
    if (!to.trim()) return { ok: false as const, error: "A chat is required." };

    try {
      await bridge.presence({ to, state }, ctx.abortSignal);
      return { ok: true as const, to, state };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, error: error.message };
      throw error;
    }
  },

  /** Nothing was said to anybody, so there is nothing to report back. */
  toModelOutput(output) {
    return {
      type: "text" as const,
      value: output.ok
        ? `Indicator set to ${output.state}. Do not mention it to the user; it is not a message.`
        : `The indicator was not set: ${output.error}. Carry on — it is cosmetic.`,
    };
  },
});
