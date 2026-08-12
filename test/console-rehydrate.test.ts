import { test } from "node:test";
import assert from "node:assert/strict";

import { formatTranscript } from "../agent/channels/console.ts";

/**
 * The console session lives in memory, so a deploy empties it mid-conversation.
 *
 * This is not a hypothetical: a rebuild landed at 23:00:46 between "make it
 * funnier" and "generate an image", and the second arrived at a process that had
 * never heard of the joke. The user saw an agent that had forgotten a message it
 * had written ninety seconds earlier.
 *
 * The chat is the durable record — the same reason tic-tac-toe keeps its board
 * there — so a cold session is refilled from it. These cover the rendering of
 * that transcript, which is the part that can silently produce something the
 * model reads wrongly.
 */

test("a transcript reads oldest first, with the time of each line", () => {
  const rendered = formatTranscript([
    { sent_at_iso: "2026-08-12T02:00:12.000Z", text: "mais engraçada" },
    { sent_at_iso: "2026-08-12T02:00:41.000Z", text: "Tenta essa: os 3 porquinhos…" },
  ]);

  assert.deepEqual(rendered.split("\n"), [
    "[02:00] mais engraçada",
    "[02:00] Tenta essa: os 3 porquinhos…",
  ]);
});

// A multi-line note is one turn, not several. Left as-is it would read as
// separate messages and inflate a two-message exchange into ten.
test("a multi-line message stays one line of transcript", () => {
  const rendered = formatTranscript([
    { sent_at_iso: "2026-08-12T02:00:00.000Z", text: "primeira\n\nsegunda\nterceira" },
  ]);

  assert.equal(rendered.split("\n").length, 1);
  assert.equal(rendered, "[02:00] primeira segunda terceira");
});

// Media rows carry a placeholder rather than a body, and a blank line in a
// transcript reads as a pause that did not happen.
test("an empty message contributes no line", () => {
  const rendered = formatTranscript([
    { sent_at_iso: "2026-08-12T02:00:00.000Z", text: "real" },
    { sent_at_iso: "2026-08-12T02:00:05.000Z", text: "   " },
    { sent_at_iso: "2026-08-12T02:00:09.000Z", text: "" },
  ]);

  assert.equal(rendered, "[02:00] real");
});

test("a message with no timestamp still appears, without a time", () => {
  const rendered = formatTranscript([{ text: "sem hora" }]);
  assert.equal(rendered, "sem hora");
});

test("an empty history renders as nothing, so no transcript block is built", () => {
  assert.equal(formatTranscript([]), "");
});
