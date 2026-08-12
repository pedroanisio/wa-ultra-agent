import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";
import { describeSpan } from "../lib/archive-span.ts";

/**
 * Whether any of this can work at all.
 *
 * ── Why it asks the transport and not only the bridge ───────────────────────
 * `/status` reports that the bridge is up and that a transport is *configured*.
 * Configured is not linked. An unpaired account answers every one of these
 * checks cheerfully and then fails every read and every send, which is the exact
 * shape of failure this project keeps trying to eliminate: a component that
 * reports healthy while holding nothing.
 *
 * So the pairing state comes from the transport itself, and `linked` is the one
 * field worth reading first.
 *
 * ── Why the archive's DATES are here ────────────────────────────────────────
 * "What period are you considering?" is a status question, and it used to have
 * no answer anywhere in the tool surface: the archive could report 8,824
 * messages across 203 chats and not the first thing about *when* they were
 * sent. An agent asked how far back it can see either hedged or guessed. The
 * counts and the span belong together, because a count without a period is not
 * a description of an archive.
 */
export default defineTool({
  description:
    "Check whether WhatsApp is actually usable. Call this first whenever another WhatsApp tool fails, " +
    "because it separates the causes that look identical from the outside: the bridge is unreachable, " +
    "no transport is configured, or the transport is running but the account is NOT LINKED. It also " +
    "reports what the archive actually holds: how many messages and chats, and THE PERIOD THEY COVER " +
    "— the oldest and newest message it has. Use it whenever the user asks how far back you can see, " +
    "what period you are considering, or what the oldest thing you have is.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    try {
      const bridgeState = await bridge.status(ctx.abortSignal);

      if (bridgeState.transport !== "configured") {
        return {
          ok: true as const,
          reachable: true,
          linked: false,
          messages: bridgeState.archive?.messages ?? 0,
          chats: bridgeState.archive?.chats ?? 0,
          span: bridgeState.archive?.span ?? null,
          provisionalChats: 0,
          whatToDo:
            "No transport is configured, so nothing can be received or sent. The operator must set " +
            "WA_TRANSPORT_URL and pair the account.",
        };
      }

      // Configured, so the transport can be asked the question that matters.
      const transport = await bridge.transportStatus(ctx.abortSignal);
      const linked = Boolean(transport.session?.loggedIn && transport.session?.connected);

      return {
        ok: true as const,
        reachable: true,
        linked,
        paired: Boolean(transport.session?.paired),
        sendEnabled: Boolean(transport.send?.enabled),
        messages: bridgeState.archive?.messages ?? 0,
        chats: bridgeState.archive?.chats ?? 0,
        span: bridgeState.archive?.span ?? null,
        provisionalChats: transport.archive?.provisionalChats ?? 0,
        whatToDo: linked
          ? "Ready."
          : transport.session?.paired
            ? "Paired but not connected. The transport is reconnecting; wait rather than re-pairing, " +
              "because a re-pair during login can cost the session."
            : "Not linked. The operator must pair the account: WhatsApp → Settings → Linked devices.",
      };
    } catch (error) {
      if (error instanceof BridgeError) {
  return { ok: false as const, reachable: false, linked: false, span: null, error: error.message };
      }
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      return {
        type: "text" as const,
        value:
          `The bridge is unreachable: ${output.error}\n\n` +
          "Nothing about WhatsApp can be read or sent. Say so and stop; do not retry other tools.",
      };
    }

    if (!output.linked) {
      return {
        type: "text" as const,
        value: `The account is NOT linked. ${output.whatToDo} Every other WhatsApp tool will fail until it is.`,
      };
    }

    const provisional =
      output.provisionalChats
        ? ` ${output.provisionalChats} chat${output.provisionalChats === 1 ? " is" : "s are"} still ` +
          "waiting for a name — `whatsapp_refresh_names` may resolve them."
        : "";

    return {
      type: "text" as const,
      value:
        `Linked and ready. The archive holds ${output.messages} messages across ${output.chats} chats, ` +
        `${describeSpan(output.span)}` +
        `${output.sendEnabled ? "" : " Sending is disabled by configuration."}${provisional}`,
    };
  },
});
