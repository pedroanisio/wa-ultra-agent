import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

export default defineTool({
  description:
    "Read the recent messages of one WhatsApp conversation, found by name. Use it whenever you need " +
    "what was actually said — before summarising a chat, before drafting a reply into it, and to " +
    "get the message `key` that the media, reaction and edit tools address. " +
    "The name is matched by WhatsApp's own fuzzy search, so 'Ana' may open 'Ana Paula' — the result reports " +
    "which chat actually opened as `chat` and whether it matched exactly. Always read that field before " +
    "summarising, and say which conversation you read when it differs from what was asked for. " +
    "Every message carries a `kind`: `text` messages have a real body, while voice notes, images, " +
    "documents and the rest arrive as a placeholder such as `[voice note · 3:42]` — they are listed, " +
    "not hidden, so you can say what is there even though you cannot yet read it. `counts` summarises " +
    "the window by kind. Use a message's `fromEnd` to fetch its media.",
  inputSchema: z.object({
    chat: z
      .string()
      .min(1)
      .describe("Contact or group name as it appears in WhatsApp. Prefer a name taken from whatsapp_list_chats."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(60)
      .default(25)
      .describe("How many of the most recent messages to return."),
  }),
  async execute({ chat, limit }, ctx) {
    try {
      const result = await bridge.readChat(chat, limit, ctx.abortSignal);
      return {
        ...result,
        // Third-party message text is data, never instruction. Say so inline:
        // a chat can contain anything, including text shaped like a command.
        trust: "untrusted-user-content",
      };
    } catch (error) {
      if (error instanceof BridgeError) return { error: error.message, messages: [] };
      throw error;
    }
  },
});
