import { defineHook } from "eve/hooks";

import { bridge } from "../lib/bridge.ts";
import { explainFailure, shouldNotify } from "../lib/turn-failure.ts";

/**
 * When a turn dies, say so on the phone.
 *
 * Every answer this agent gives is a tool call — `whatsapp_write_self` — so a
 * turn that fails before the model produces one writes nothing at all. The user
 * sees their own message sitting there unanswered and cannot tell whether the
 * agent is thinking, asleep, or broken. This closes that: one line, in the chat
 * they are already looking at, naming what failed.
 *
 * It writes through the bridge directly and never starts a turn, so a failure
 * cannot recurse into a second failure. Repeats of the same fault are held for
 * `REPEAT_SILENCE_MS` — a dead key fails every scheduled turn, and the tenth
 * copy of that news is noise. The record is process-local on purpose: a restart
 * re-reports, which is the right way round for something whose whole job is to
 * not stay quiet.
 */
const reported = new Map<string, number>();

export default defineHook({
  events: {
    "turn.failed": async (event) => {
      const note = explainFailure({
        code: event.data.code,
        message: event.data.message,
        details: event.data.details as Record<string, unknown> | undefined,
      });

      if (!shouldNotify(note.signature, Date.now(), reported)) return;

      try {
        await bridge.writeSelf([note.body]);
      } catch (error) {
        // The bridge being unreachable is exactly the kind of thing that also
        // kills turns, and there is no third channel to complain on. Log it and
        // let the next failure try again.
        console.error("[turn-failure] could not deliver the failure note:", (error as Error).message);
      }
    },
  },
});
