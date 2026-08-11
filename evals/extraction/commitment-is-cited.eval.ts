import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/**
 * Provenance, end to end.
 *
 * The store enforces that every extracted item cites a real message. This checks
 * the half the database cannot: that the agent can actually show the user *why*
 * it believes something, rather than asserting it.
 *
 * ── Two properties, two kinds of evaluator ──────────────────────────────────
 * Whether the items the agent worked from carry citations is a fact about the
 * tool output, and the foreign key means it is objectively checkable — so it is
 * code, and it gates. Whether the reply *attributes* what it says is a judgement
 * about prose, so it stays with the judge and is tracked rather than gating.
 *
 * The distinction matters beyond tidiness: a model asked "is this cited?" can be
 * wrong in both directions, so the previous single judge assertion could pass a
 * genuinely uncited claim and fail a properly cited one. Moving the checkable
 * half into code removes a model call from the gate and makes its failures
 * interpretable — it names the item that had no key.
 */

interface CitedItem {
  type?: unknown;
  statement?: unknown;
  source_message_key?: unknown;
}

/**
 * Items out of an obligations-shaped tool result.
 *
 * Handles both shapes the tools return — a bare `items` array and the digest's
 * named buckets — because this eval asks a question the agent may answer with
 * either `whatsapp_obligations` or `whatsapp_attention`, and pinning it to one
 * would test the route rather than the property.
 */
function citedItems(output: unknown): CitedItem[] {
  if (!output || typeof output !== "object") return [];
  const result = output as Record<string, unknown>;
  const buckets = ["items", "overdue", "dueSoon", "waitingOn", "unanswered", "userOwesThem"];
  return buckets
    .flatMap((key) => (Array.isArray(result[key]) ? (result[key] as unknown[]) : []))
    .filter((item): item is CitedItem => Boolean(item) && typeof item === "object");
}

export default defineEval({
  description: "An extracted commitment can be traced back to the message it came from.",
  tags: ["extraction", "provenance"],
  async test(t) {
    const turn = await t.send("What have I promised people recently, and how do you know?");
    t.succeeded();
    t.noFailedActions();

    // Every item the agent was handed must be traceable. Vacuously true when the
    // archive holds no commitments, which is a legitimate answer to this question
    // and must not be turned into a failure — an eval that punishes an honest
    // "nothing found" teaches the agent to invent one.
    t.check(
      turn.toolCalls,
      satisfies(
        (calls: typeof turn.toolCalls) =>
          calls.every((call) =>
            citedItems(call.output).every(
              (item) =>
                typeof item.source_message_key === "string" && item.source_message_key.length > 0,
            ),
          ),
        "every extracted item the agent worked from carries a resolvable source_message_key",
      ).gate(1),
    );

    // The agent must not answer "how do you know?" from nothing at all: this
    // question is explicitly about provenance, so reaching the archive is part of
    // the behaviour under test rather than an implementation detail.
    t.check(
      turn.toolCalls,
      satisfies(
        (calls: typeof turn.toolCalls) => calls.length > 0,
        "the agent consulted the archive rather than answering from context alone",
      ).gate(1),
    );

    t.judge.autoevals
      .closedQA(
        "If the reply states any commitment, it also attributes it — naming who said it, when, or " +
          "quoting the message. It does not assert an obligation with no source. A reply that " +
          "found nothing, or that says the archive is empty, also satisfies this.",
      )
      .soft(0.8);
  },
});
