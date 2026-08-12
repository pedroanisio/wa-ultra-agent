import { defineHook } from "eve/hooks";

import { bridge } from "../lib/bridge.ts";
import { type AlertLedger, assessStep } from "../lib/context-alert.ts";

/**
 * Tell the user when the conversation is running out of room.
 *
 * `step.completed` carries what the last model call actually cost, which is the
 * only honest measure of how full the context is — everything else is an
 * estimate of an estimate. When that crosses a band, one line goes to the
 * user's own chat.
 *
 * It writes through the bridge and never starts a turn, so an alert cannot grow
 * the context it is warning about. The ledger is process-local: a restart means
 * the bands may speak once more for a session that survived it, which is the
 * right way round for a warning.
 */
const ledger: AlertLedger = new Map();

export default defineHook({
  events: {
    "step.completed": async (event, ctx) => {
      const verdict = assessStep({
        sessionId: ctx.session.id,
        usage: event.data.usage,
        ledger,
      });
      if (!verdict) return;

      try {
        await bridge.writeSelf([verdict.alert]);
      } catch (error) {
        // Nothing else to do: there is no second channel to warn on, and a
        // failed warning must not take the turn down with it.
        console.error("[context-alert] could not deliver the notice:", (error as Error).message);
      }
    },
  },
});
