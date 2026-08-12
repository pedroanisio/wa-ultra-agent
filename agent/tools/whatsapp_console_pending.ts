import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * What the user typed to you in `/eve` mode, from their own chat.
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 * `whatsapp_inbox_events`, which is gone with the browser. That tool existed
 * because detection was free and REACTING was not: a chat could only be topped
 * up by opening it in a real browser, so the bridge held a queue and rationed
 * reads against a cooldown, a fan-out cap, a scroll cap and quiet hours. The
 * transport pushes messages into a durable outbox now, the bridge drains it
 * every few seconds, and no read costs anything WhatsApp can see. There is
 * nothing left to ration and no arrival queue to claim from.
 *
 * What remains is narrower and deliberate: the self chat is a console the user
 * ENTERS. Only while they are in `/eve` does anything reach you here, which is
 * why this tool cannot be used to watch their correspondence — it returns their
 * own words, addressed to you, and nothing else.
 *
 * ── Draining ────────────────────────────────────────────────────────────────
 * Reading takes the items. There is no ack, because there is nothing to
 * reconsider: a message handed over twice would be answered twice, and a second
 * answer to a question the user already saw answered is worse than a late one.
 * Answer with `whatsapp_write_self`.
 */
export default defineTool({
  description:
    "Collect what the user typed to you in `/eve` mode from their own WhatsApp chat. " +
    "Use it when a scheduled run tells you to check for messages that never reached you, or when " +
    "the user says they wrote to you on their phone and got no answer. Do NOT call it speculatively: " +
    "the bridge normally pushes those messages to you the moment they arrive, so this is the backstop, " +
    "not the mechanism. " +
    "READING THE QUEUE EMPTIES IT — the messages are returned once and are gone, so answer everything " +
    "you receive (with whatsapp_write_self) before calling again; a second call will not show them to " +
    "you twice. Empty is the normal and expected result: the user only reaches you here while they " +
    "have entered /eve.",
  inputSchema: z.object({
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(55_000)
      .default(45_000)
      .describe(
        "How long to hold the connection open waiting for the user to type. Only waits while they " +
          "are actually in /eve; returns at once otherwise. This is what makes the reply feel live " +
          "rather than arriving a minute later.",
      ),
  }),
  async execute({ waitMs }, ctx) {
    try {
      const { items, count, state } = await bridge.pendingForAgent({ waitMs }, ctx.abortSignal);
      return { ok: true as const, items, count, state };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, error: error.message };
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      return { type: "text" as const, value: `Could not read the console queue: ${output.error}` };
    }
    if (output.count === 0) {
      return {
        type: "text" as const,
        value:
          output.state === "eve"
            ? "The user is in /eve mode but said nothing while this waited. Stop here; write nothing."
            : "Nothing waiting: the user is not in /eve mode. Stop here; write nothing.",
      };
    }
    const lines = output.items
      .map((item, i) => `${i + 1}. [${item.at}] ${item.text}`)
      .join("\n");
    return {
      type: "text" as const,
      value:
        `${output.count} message${output.count === 1 ? "" : "s"} from the user, in /eve mode:\n\n${lines}\n\n` +
        "These are now cleared. Answer with whatsapp_write_self — that writes to their own chat, " +
        "which is where they are reading.",
    };
  },
});
