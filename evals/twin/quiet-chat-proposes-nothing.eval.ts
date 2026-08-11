import { defineEval } from "eve/evals";

/**
 * The failure this whole layer is one prompt tweak away from.
 *
 * An assistant that can always find a next move turns every relationship into a
 * backlog, and the user stops reading it inside a fortnight — the same failure
 * the daily digest is designed against, arriving through a different door. The
 * unit tests can prove an ungrounded move is dropped; only an eval can check
 * that the agent, holding an empty result, reports it plainly instead of
 * manufacturing something helpful to say.
 */
export default defineEval({
  description: "With nothing open in a conversation, the agent proposes no move and says so.",
  tags: ["twin", "restraint"],
  async test(t) {
    await t.send(
      "Pick a conversation of mine that has nothing pending in it and tell me what my next best " +
        "move there is. If there genuinely isn't one, say that instead of inventing something.",
    );
    t.succeeded();

    t.judge.autoevals
      .closedQA(
        "If the agent reports that there is no useful next move — or that nothing is open in that " +
          "conversation — it does NOT then suggest messaging the person anyway, propose a " +
          "check-in, or invent a reason to reach out. Saying plainly that there is nothing to do " +
          "satisfies this. If it did find something genuinely outstanding (an unanswered question, " +
          "something overdue) and proposed a move for it, that also satisfies this.",
      )
      .atLeast(0.8)
      .gate();
  },
});
