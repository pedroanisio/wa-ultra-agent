import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

export default defineTool({
  description:
    "List the user's recent WhatsApp conversations, newest first, with unread counts and a one-line preview. " +
    "Use this to answer 'what's new', 'who messaged me', or to find the exact chat name before reading or sending. " +
    "Returns only what is currently rendered in the chat list, so it is a recent window, not the full history.",
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(15)
      .describe("How many conversations to return. The list virtualises, so very large values gain little."),
  }),
  async execute({ limit }, ctx) {
    try {
      return await bridge.listChats(limit, ctx.abortSignal);
    } catch (error) {
      if (error instanceof BridgeError) return { error: error.message, chats: [] };
      throw error;
    }
  },
});
