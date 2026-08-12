/**
 * What to do about a turn that ended without saying anything.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 * A user in `/eve` mode typed "Hello" twice, twenty-two minutes apart, and got
 * nothing back either time. Both turns were received, both opened a record, and
 * both ended `silent` in 0.0s with `steps=0` — the model was never called. The
 * console's continuation address pointed at a run eve had already moved to a
 * terminal state (`Cannot set attributes on run in terminal state "completed"`),
 * so every message after that opened a turn against a dead run and ended
 * instantly. `/quit` and re-entering `/eve` could not clear it, because the
 * address deliberately survives leaving the state — see `console.ts`.
 *
 * The user could not distinguish any of that from "the agent ignored me".
 *
 * ── Why the prompt was not the fix ──────────────────────────────────────────
 * `composePrompt` already tells the model, in as many words, that "Silence is
 * the one unacceptable outcome". That instruction was in place for every one of
 * those turns and could not have helped: the model never ran. Even when it does
 * run, an instruction is a request, not a guarantee.
 *
 * ARCHITECTURAL REQUIREMENT (PALS's LAW): LLMs will always produce some form of
 * error. Absence of output verification is a design defect, not a runtime bug.
 * All LLM output must be treated as untrusted and validated explicitly.
 *
 * This module is that verification layer for one specific claim — "a turn
 * produced something the user can see". It is pure so the rule can be tested
 * without a channel, a bridge, a model or a clock.
 */

/**
 * Tools that put something into the user's OWN chat.
 *
 * A turn that called one of these has already been heard from, so a note saying
 * nothing happened would contradict what is on the user's screen.
 *
 * The `whatsapp_send_*` family is deliberately absent. Those take a recipient,
 * and the tool NAME does not say who it was — a turn that messaged a
 * correspondent and told the user nothing is still a turn the user is owed a
 * word about. Reporting a delivery that went elsewhere is the safer error than
 * staying quiet about one that never came.
 */
export const DELIVERING_TOOLS: ReadonlySet<string> = new Set([
  "whatsapp_write_self",
  "whatsapp_deliver_render",
]);

/**
 * Below this, a turn cannot have reached the provider and come back.
 *
 * The two zero-step silences are different faults and need different answers,
 * and the only thing separating them is the clock: a turn against a run that
 * can no longer accept work ends in 0–1ms, while a provider that rejects the
 * request still costs a round trip. Both observed on the same afternoon — 0.0s
 * for a dead session, 2.6s for a model that refused the tool call.
 *
 * A quarter second is far above any local return and far below any real call.
 */
export const REACHED_THE_MODEL_MS = 250;

/** What a finished turn looked like, as far as this decision is concerned. */
export interface SilentTurn {
  /** Model steps completed. Zero means no assistant message was produced. */
  readonly steps: number;
  /** Wall time of the whole turn. Distinguishes the two zero-step silences. */
  readonly elapsedMs: number;
  /** Tool names this turn called, in order. */
  readonly tools: readonly string[];
  /**
   * Whether this turn was already a retry, or cannot be retried.
   *
   * Both collapse to the same decision — do not retry again — and keeping them
   * as one flag stops a caller with no original request from having to invent
   * one to avoid a loop.
   */
  readonly retried: boolean;
}

/**
 * What the channel should do about the silence.
 *
 * `retry` carries a body too: the user is told the conversation is being
 * restarted BEFORE the retry runs, because the retry itself takes seconds and
 * an unexplained pause is the thing being fixed.
 */
export type SilenceAction =
  | { readonly kind: "none" }
  | { readonly kind: "retry"; readonly body: string }
  | { readonly kind: "report"; readonly body: string };

/**
 * Decide what a silent turn owes the user.
 *
 * The three cases are genuinely different failures and are worded differently
 * on purpose — "I never got to think about it" and "I thought about it and
 * produced nothing" send the user to different places, and a single generic
 * apology would send them to neither.
 */
export function silenceAction(turn: SilentTurn): SilenceAction {
  if (turn.tools.some((name) => DELIVERING_TOOLS.has(name))) {
    return { kind: "none" };
  }

  // Instant and empty: the model was never asked. The only thing that produces
  // this is a session that can no longer accept turns, which a fresh one fixes.
  if (turn.steps === 0 && turn.elapsedMs < REACHED_THE_MODEL_MS) {
    if (!turn.retried) {
      return {
        kind: "retry",
        body:
          "♻️ That went into a conversation that had already ended, so nothing ran. " +
          "Starting a fresh one and trying again — the chat is the record, so nothing is lost.",
      };
    }
    return {
      kind: "report",
      body:
        "⚠️ I could not answer that: the session would not accept the message, and " +
        "starting a fresh one did not help either. The agent needs restarting.",
    };
  }

  // Reached the provider and came back with nothing. This is the shape a
  // rejected request takes by the time it gets here — the harness reports a
  // refusal as an empty response, so "the model said nothing" and "the model
  // was not allowed to answer" are indistinguishable at this layer. Naming the
  // model configuration is therefore the honest pointer, and it is the one that
  // would have saved the afternoon this was written on.
  if (turn.steps === 0) {
    return {
      kind: "report",
      body:
        "⚠️ The model returned nothing at all for that — no words and no tool call. " +
        "That usually means the request was refused before it ran, so the model " +
        "configuration is the thing to check.",
    };
  }

  return {
    kind: "report",
    body:
      "⚠️ I ran that turn but produced no reply, so there is nothing to show you. " +
      "Send it again, or rephrase it — nothing was sent to anyone.",
  };
}
