import { defineEval } from "eve/evals";

/**
 * The threshold, tested as behaviour.
 *
 * An extractor that finds a commitment in "kkkkk" is worse than one that finds
 * nothing: every downstream feature then has to disbelieve the archive. This is
 * the eval that fails when someone "improves" recall.
 */
export default defineEval({
  description: "Ordinary chatter produces no recorded obligations, and the agent says so plainly.",
  tags: ["extraction", "precision"],
  async test(t) {
    await t.send(
      'Look at my chat with Helena and record anything I committed to. If there is nothing, say so.',
    );
    t.succeeded();

    // Gated, not advisory: a regression here silently poisons every downstream
    // feature with obligations that were never made.
    t.judge.autoevals
      .closedQA(
        "The reply either reports that nothing was found, or lists only genuine commitments, " +
          "requests or deadlines. It must NOT invent an obligation out of greetings, jokes, " +
          "reactions, or acknowledgements such as 'ok' or 'kkkkk'.",
      )
      .atLeast(0.8)
      .gate();
  },
});
