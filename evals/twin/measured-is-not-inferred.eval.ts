import { defineEval } from "eve/evals";

/**
 * The twin's two halves have different standing, and the agent is the only place
 * that distinction can survive.
 *
 * "You reply to her within the hour and it has been nine days" is arithmetic over
 * archived rows. "She is waiting on the price before she can book the tiler" is a
 * model's reading of her messages. Presented in one confident breath they are
 * indistinguishable, and the second one is the one that can be wrong — this is
 * the same rule as `personal-vs-internet`, applied inside a single tool result.
 *
 * Staleness rides along here because it fails the same way: a twin modelled three
 * weeks ago reads exactly like one modelled this morning unless the agent says so.
 */
export default defineEval({
  description: "Counted figures and modelled readings are told apart, and a stale twin is disclosed.",
  tags: ["twin", "provenance"],
  async test(t) {
    await t.send("Where does my conversation with the person I message most stand right now?");
    t.succeeded();
    t.calledTool("whatsapp_twin");

    t.judge.autoevals
      .closedQA(
        "The reply does not present interpretations of what someone wants as established fact. " +
          "Where it says what the other person is trying to achieve, it is framed as a reading of " +
          "their messages (\"it looks like\", \"from what she wrote\") rather than asserted flatly. " +
          "Statistics about timing or message counts may be stated plainly. If the tool reported " +
          "that its model of the conversation is out of date, or that the chat was never modelled, " +
          "the reply says so rather than describing the conversation as if the picture were current.",
      )
      .atLeast(0.8)
      .gate();
  },
});
