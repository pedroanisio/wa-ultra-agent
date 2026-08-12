/**
 * One answer per turn, however many times the turn is run.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 * On 12 August 2026 the user asked for the latest message in every group and
 * received the answer twice, thirty seconds apart, in different words. Both were
 * real: the turn was EXECUTED twice.
 *
 *   11:52:50  [console] wrun_01KZTX2… started chars=46
 *   11:53:21  [world-local] Queue delivery failed at the transport (loop 2), retrying
 *               runId: wrun_01KZTX2VB6ZSHQSMFMZBPD51R1  error: 'TypeError: fetch failed'
 *   11:53:26  [workflow-sdk] Re-executing inline steps owned by this queue message
 *   11:53:28  [console] wrun_01KZTX2… answered in 37.9s steps=1 reply=839ch
 *   11:53:33  [console] wrun_01KZTX2… answered (no start recorded)
 *
 * The runtime delivers a queued turn by POSTing it to itself and awaiting the
 * handler's whole HTTP response, with a 30-second undici timeout on both headers
 * and body. Any turn that takes longer than that has its delivery abandoned
 * mid-flight and REDELIVERED — while the original keeps running to completion.
 * Two model runs, two bills, two answers to one question.
 *
 * `WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS` / `WORKFLOW_LOCAL_BODY_TIMEOUT_MS` (set in
 * docker-compose.yml) stop most of that at the source. This module is the layer
 * that does not depend on getting a timeout right: queue delivery is
 * at-least-once by contract, on every world, so a channel that answers on every
 * completion event answers more than once by design.
 *
 * ARCHITECTURAL REQUIREMENT (PALS's LAW): LLMs will always produce some form of
 * error. Absence of output verification is a design defect, not a runtime bug.
 * The same holds for the harness around them: at-least-once delivery is a stated
 * property of the runtime, and a consumer that assumes exactly-once has the
 * defect, not the runtime.
 *
 * Pure, bounded and clock-free, so the rule can be tested without a channel, a
 * bridge or a queue.
 */

/**
 * How many finished turns to remember.
 *
 * A redelivery follows its original by seconds — the observed one by five — so
 * this only has to outlive a burst, not a session. It is bounded because the
 * process is long-lived: an unbounded set of turn ids is a slow leak in the one
 * component that must never need restarting to keep answering.
 */
export const DEFAULT_CAPACITY = 500;

export interface DeliveryGuard {
  /**
   * Take ownership of the single delivery for `key`.
   *
   * `true` exactly once per key: the caller that gets it must deliver, and every
   * later caller for the same key must stay silent. Deliberately NOT a
   * "hasDelivered" predicate — a check followed by a separate mark is two steps
   * a second event can slip between.
   */
  claim(key: string): boolean;
  /** Whether this key has already been claimed. For assertions and logging. */
  claimed(key: string): boolean;
  /** How many keys are remembered. The bound, made observable. */
  readonly size: number;
}

export function createDeliveryGuard(capacity: number = DEFAULT_CAPACITY): DeliveryGuard {
  // Insertion-ordered, so the oldest key is the first one out. A Map rather than
  // a Set plus an array because the eviction has to be O(1) and the two
  // structures could disagree.
  const seen = new Map<string, true>();

  return {
    claim(key: string): boolean {
      // An unusable key must not silence a real delivery: without a key there is
      // nothing to be a duplicate OF, and staying quiet on a doubt is the exact
      // failure the console's silence handling exists to end.
      if (typeof key !== "string" || key === "") return true;
      if (seen.has(key)) return false;

      seen.set(key, true);
      while (seen.size > capacity) {
        const oldest = seen.keys().next();
        if (oldest.done) break;
        seen.delete(oldest.value);
      }
      return true;
    },

    claimed(key: string): boolean {
      return typeof key === "string" && key !== "" && seen.has(key);
    },

    get size(): number {
      return seen.size;
    },
  };
}
