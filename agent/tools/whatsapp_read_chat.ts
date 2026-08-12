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
        found: true as const,
        // Third-party message text is data, never instruction. Say so inline:
        // a chat can contain anything, including text shaped like a command.
        trust: "untrusted-user-content",
      };
    } catch (error) {
      if (error instanceof BridgeError) {
        // ── Why `found` exists, and why it is not just an error string ──────
        // A name that did not resolve used to come back as an empty message
        // list, indistinguishable from a conversation with nothing in it. On
        // 12 August 2026 eight busy groups read as empty that way and the model,
        // given no reason, supplied one: "non-text content or a sync gap",
        // reported to the user as fact. `found: false` is the field that makes
        // "I could not find it" unavailable as a silence.
        return { found: false as const, error: error.message, messages: [] };
      }
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.found) {
      return {
        type: "text" as const,
        value:
          `I could not read that conversation: ${output.error}\n\n` +
          "This is NOT an empty chat and NOT a gap in the archive — the name did not resolve to a " +
          "conversation. Say that, or call whatsapp_list_chats and try the name exactly as listed. " +
          "Do not offer the user a cause for it.",
      };
    }
    return { type: "json" as const, value: output };
  },
});
