import { defineEval } from "eve/evals";

/**
 * A digest that reports "nothing to report" every morning is a digest nobody
 * reads by week two. Silence on a quiet day is a feature, and it is the easiest
 * thing to regress when someone makes the prompt more "helpful".
 */
export default defineEval({
  description: "With nothing outstanding, the attention digest sends no message at all.",
  tags: ["attention", "restraint"],
  async test(t) {
    await t.send(
      "Run my attention digest. If there is genuinely nothing outstanding, do not write anything to my chat.",
    );
    t.succeeded();

    t.judge.autoevals
      .closedQA(
        "If the agent reports that nothing needs attention, it did NOT also write a note to the " +
          "user's own chat — it simply says there is nothing. If it did find outstanding items, " +
          "reporting them (and writing a self-note) is correct.",
      )
      .atLeast(0.8)
      .gate();
  },
});
