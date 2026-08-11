import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * Send in one call. The allowlist, not a confirmation prompt, is the boundary.
 *
 * The bridge refuses any recipient that is not configured as allowed, and
 * re-verifies that the resolved conversation is the one open immediately before
 * typing. So a wrong or repeated call is bounded by configuration rather than by
 * a human reading every message.
 */
export default defineTool({
  description:
    "Send a WhatsApp message. This is IRREVERSIBLE — the recipient sees it immediately. " +
    "Only recipients on the operator's allowlist can be messaged; anyone else is refused with a 403, which " +
    "is a deliberate guard and not something to work around. Prefer a chat name taken from " +
    "whatsapp_list_chats: the name is matched by WhatsApp's own fuzzy search, and the result reports " +
    "`resolvedRecipient` plus `exactMatch` so you can see who was actually messaged. If `exactMatch` is " +
    "false, tell the user which chat it went to. Write the message in the user's voice and in the language " +
    "of the conversation; never add a signature or disclaimer they did not ask for.",
  inputSchema: z.object({
    to: z
      .string()
      .min(1)
      .describe(
        "Contact or group name as it appears in WhatsApp. Use the exact name from whatsapp_list_chats when " +
          "you have it. Do not include decorations WhatsApp adds in the UI, such as a trailing '(You)' — " +
          "search does not match those.",
      ),
    message: z
      .string()
      .min(1)
      .max(4000)
      .describe("The exact text to send. Newlines are preserved as line breaks within one message."),
  }),
  async execute({ to, message }, ctx) {
    try {
      return await bridge.sendMessage(to, message, ctx.abortSignal);
    } catch (error) {
      if (error instanceof BridgeError) {
        return {
          sent: false,
          error: error.message,
          // 403 is the allowlist doing its job; say so rather than retrying.
          reason: error.status === 403 ? "not permitted by the operator's allowlist" : undefined,
        };
      }
      throw error;
    }
  },
});
