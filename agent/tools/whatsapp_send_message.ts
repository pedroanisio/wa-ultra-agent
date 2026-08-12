import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";
import { sendApproval } from "../lib/send-policy.ts";

/**
 * Send in one call, behind two independent guards.
 *
 * ── WHO, and then WHAT ──────────────────────────────────────────────────────
 * The bridge's allowlist bounds WHO may be written to, and it lives there rather
 * than here because a cap the agent enforces is a cap a confused agent can talk
 * itself out of. It cannot bound WHAT is said: both people on the list are
 * people to whom "on my way" and "I'll pay you Friday" are very different
 * messages to receive under the user's own name.
 *
 * So `approval` below answers the second question. The prepare/commit dance that
 * used to do this went with the DOM path; expressing it as an eve approval
 * policy is strictly better, because the pause is durable and can be answered
 * from whichever channel the user is actually on — including their own phone.
 *
 * `sendApproval` errs towards asking: the two failures are not symmetrical. A
 * needless prompt costs a tap; a missed one sends a promise in someone's name.
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
  /**
   * Commitment-shaped messages stop for a human; ordinary ones do not.
   *
   * Not `always()`: a confirmation on every "on my way" trains the user to tap
   * through without reading, which is worse than no gate at all. Not `once()`
   * either — the risk is per-message, not per-session.
   */
  approval: sendApproval,

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
