import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

/**
 * Ask a group a question with countable answers.
 *
 * A poll is the one message shape that gets a group to a decision without
 * producing forty messages of "+1" that then have to be read and tallied by
 * somebody. The archive stores votes as messages like any other, so the answer
 * is auditable later.
 */
export default defineTool({
  description:
    "Send a poll to a chat, or vote in one. Use it to settle a question with a group — a date, a place, " +
    "a choice — instead of asking in prose and counting replies by hand. Give `options` to create a " +
    "poll; give `messageId` and `vote` to answer a poll somebody else sent. A poll needs at least two " +
    "options, and `selectableCount` above one lets people pick several.",
  inputSchema: z.object({
    to: z.string().min(1).describe("The chat to poll, by name."),
    name: z.string().max(255).optional().describe("The question. Required when creating a poll."),
    options: z
      .array(z.string().min(1).max(100))
      .max(12)
      .optional()
      .describe("The answers to offer, two or more. Required when creating a poll."),
    selectableCount: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("How many options one person may choose. Defaults to 1."),
    messageId: z
      .string()
      .optional()
      .describe("To VOTE instead of create: the poll message's `key` from the archive."),
    vote: z
      .array(z.string().min(1))
      .optional()
      .describe("To vote: the option texts being chosen, exactly as the poll words them."),
  }),
  async execute({ to, name, options, selectableCount, messageId, vote }, ctx) {
    if (!to.trim()) return { ok: false as const, error: "A chat is required." };

    try {
      if (messageId) {
        if (!vote?.length) {
          return { ok: false as const, error: "Voting needs at least one option to vote for." };
        }
        const cast = await bridge.votePoll({ to, messageId, options: vote }, ctx.abortSignal);
        return { ok: true as const, voted: true, id: cast.id, chose: vote };
      }

      // A poll with one answer is not a question, and the transport would take
      // it. Refused here so the mistake costs nothing and is explained.
      if (!name?.trim()) return { ok: false as const, error: "A poll needs a question." };
      if (!options || options.length < 2) {
        return { ok: false as const, error: "A poll needs at least two options to choose between." };
      }

      const sent = await bridge.sendPoll({ to, name, options, selectableCount }, ctx.abortSignal);
      return { ok: true as const, voted: false, id: sent.id, name, options };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, error: error.message };
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) return { type: "text" as const, value: `The poll failed: ${output.error}` };
    return {
      type: "text" as const,
      value: output.voted
        ? `Voted: ${output.chose?.join(", ")}.`
        : `The poll is in the chat. Results arrive as votes, so do not report a tally you have not read.`,
    };
  },
});
