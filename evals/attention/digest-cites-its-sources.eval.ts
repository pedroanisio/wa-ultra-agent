import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/**
 * The digest is the most-read output of the whole system, so it is where an
 * uncited claim does the most damage: the user acts on it without ever seeing the
 * message it came from.
 *
 * ── Why this is two assertions and not one judge call ───────────────────────
 * "Is every obligation cited?" was previously one LLM-as-judge question, and that
 * conflated two properties with very different natures:
 *
 *   1. Did the data the agent was handed actually carry citations that resolve?
 *      Objective. The store has a foreign key onto `messages(key)`, so this is a
 *      property of the tool output, checkable by reading it. No model needed —
 *      and a model asked this question can be wrong about it, which means a
 *      failure here could previously pass and a pass could previously fail.
 *   2. Did the reply *tell the user* where each item came from? Genuinely
 *      interpretive. Attribution can be phrased a hundred ways, and no predicate
 *      recognises them all.
 *
 * So (1) is now a code assertion and the hard gate: deterministic, free, and
 * interpretable when it fails. (2) stays with the judge but is tracked rather
 * than gating, because a gate that depends on a model's reading of prose fails
 * for reasons that are not regressions.
 *
 * This is the split the evals literature recommends — code evaluators where the
 * property is objective, "fast, cheap, deterministic and interpretable",
 * reserving a judge for where nuance is genuinely required.
 */

/** A row that a digest item must look like for its citation to be traceable. */
interface CitedRow {
  statement?: unknown;
  source_message_key?: unknown;
  source_chat?: unknown;
}

/**
 * Every item in every bucket of the digest, flattened.
 *
 * Reads the tool's own output rather than the reply text, because the reply is
 * prose and this assertion is about the data behind it.
 */
function digestRows(output: unknown): CitedRow[] {
  if (!output || typeof output !== "object") return [];
  const digest = output as Record<string, unknown>;
  return ["overdue", "dueSoon", "waitingOn", "unanswered"]
    .flatMap((bucket) => (Array.isArray(digest[bucket]) ? (digest[bucket] as unknown[]) : []))
    .filter((row): row is CitedRow => Boolean(row) && typeof row === "object");
}

export default defineEval({
  description: "Items in the digest are attributed to who said them and where.",
  tags: ["attention", "provenance"],
  async test(t) {
    const turn = await t.send("What needs my attention?");
    t.succeeded();
    t.calledTool("whatsapp_attention");
    t.noFailedActions();

    const attention = turn.toolCalls.filter((call) => call.name === "whatsapp_attention");

    // The objective gate. Every obligation the agent was given must carry a
    // message key it can be traced back to. An empty digest satisfies this
    // vacuously, and that is correct: a quiet day is a real answer, and the
    // separate `quiet-day-is-silent` eval is what stops emptiness being filled.
    t.check(
      attention,
      satisfies(
        (calls: typeof attention) =>
          calls.length > 0 &&
          calls.every((call) =>
            digestRows(call.output).every(
              (row) =>
                typeof row.source_message_key === "string" && row.source_message_key.length > 0,
            ),
          ),
        "every obligation in the digest carries a resolvable source_message_key",
      ).gate(1),
    );

    // Interpretive, so tracked rather than gating.
    t.judge.autoevals
      .closedQA(
        "Every obligation the reply mentions is attributed — naming the person and/or the " +
          "conversation it came from. It does not present an obligation as a bare fact with no " +
          "source. A reply stating that nothing needs attention also satisfies this.",
      )
      .soft(0.8);
  },
});
