import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * Close an obligation out.
 *
 * The list is only useful if it shrinks. Without this, every extraction pass
 * adds to a backlog that never clears, and a digest that keeps reporting a
 * commitment the user honoured last week trains them to ignore it.
 *
 * Private mutation: it changes a local record and reaches nobody, so it needs
 * no approval — but it must reflect something the user actually said.
 */
export default defineTool({
  description:
    "Mark a recorded obligation as handled. Use `done` when it actually happened and `dropped` when " +
    "it will not. Take the id from whatsapp_obligations (shown as #id). Only do this when the user " +
    "has said the thing is finished or no longer applies — never because it looks old, and never to " +
    "tidy the list up on their behalf.",
  inputSchema: z.object({
    id: z.number().int().describe("The #id shown by whatsapp_obligations."),
    status: z
      .enum(["done", "dropped"])
      .default("done")
      .describe("`done` if it happened, `dropped` if it no longer applies."),
  }),
  async execute({ id, status }, ctx) {
    try {
      const result = await bridge.resolveExtraction({ id, status }, ctx.abortSignal);
      return { ok: true as const, ...result };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, error: error.message };
      throw error;
    }
  },

  toModelOutput(output) {
    return output.ok
      ? { type: "text" as const, value: `Item #${output.id} marked ${output.status}.` }
      : { type: "text" as const, value: `Could not update that item: ${output.error}` };
  },
});
