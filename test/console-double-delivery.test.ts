import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The two places that decide whether one question gets one answer.
 *
 * ── Why the prompt is tested as a file ──────────────────────────────────────
 * The `/eve` reply is delivered by the channel when the turn ends. Two documents
 * tell the model what to do with a finished answer, and they used to disagree:
 * `agent/instructions.md` said to deliver work with `whatsapp_write_self`, and
 * the console's own prompt said not to, "because calling it would send your
 * answer twice". A model handed both will sometimes follow the first, and the
 * user gets the same answer in two bubbles, worded differently, with no way to
 * tell which one was meant.
 *
 * Nothing type-checks a contradiction between two pieces of prose, and no unit
 * test would have caught it: both files were individually correct. So the
 * agreement between them is asserted here, in the only form it has — the words.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const instructions = read("../agent/instructions.md");
const channel = read("../agent/channels/console.ts");

test("the console prompt tells the model not to deliver its own reply", () => {
  // In `composePrompt`. The channel delivers the final text itself; a model that
  // also calls the tool sends it twice.
  assert.match(channel, /you do NOT need to call\s*\n?\s*\/\/ whatsapp_write_self|do NOT need to call/);
  assert.match(channel, /would send your answer twice/);
});

test("the standing instructions carve out the same exception", () => {
  const section = instructions.slice(instructions.indexOf("# Delivering work to the user"));
  assert.ok(section.length > 0, "the delivering-work section must exist");

  assert.match(
    section,
    /\/eve/,
    "the section that tells the model to use whatsapp_write_self must name the case where it must not",
  );
  assert.match(section, /TWICE|twice/);
});

test("the channel still delivers the reply itself, once", () => {
  // The guard is what makes a re-executed turn harmless; the delivery is what
  // makes an answer arrive at all. Removing either reintroduces a shipped bug —
  // saying it twice, or not saying it. See lib/delivery-guard.ts.
  assert.match(channel, /deliveries\.claim\(deliveryKey\(event, ctx\)\)/);
  assert.match(channel, /await deliverToWhatsApp\(reply\)/);
});
