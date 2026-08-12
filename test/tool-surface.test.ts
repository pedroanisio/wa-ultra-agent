import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * The shape of the tool surface, held to what a smaller model can choose from.
 *
 * ── Why this is a test and not a style note ─────────────────────────────────
 *
 * There are thirty-six tools here. Selecting the right one is the model's job,
 * and it does that job from the descriptions — so on a 200K-token model the
 * descriptions are not documentation, they are the mechanism. Anthropic's own
 * guidance is blunt about which way this fails: the common defect is tools that
 * are UNDER-described, and a description that states *when* to call the tool
 * measurably outperforms one that only states what it does.
 *
 * This file asserts that property mechanically, because it is the kind that
 * decays one hurried tool at a time and never announces itself — a wrong tool
 * choice reads as a confused model, not as a thin description.
 */

const TOOL_DIR = new URL("../agent/tools/", import.meta.url);

const files = readdirSync(TOOL_DIR).filter((name) => name.endsWith(".ts"));

/** The `description:` string a tool passes to `defineTool`, concatenated. */
function descriptionOf(source: string): string {
  const start = source.indexOf("description:");
  if (start < 0) return "";
  // The description is a run of adjacent string literals; take everything up to
  // the next top-level key rather than trying to parse TypeScript.
  const end = source.indexOf("inputSchema:", start);
  const slice = source.slice(start, end > 0 ? end : start + 4000);
  return [...slice.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join(" ");
}

test("there are tools to check", () => {
  assert.ok(files.length > 10, `expected a real tool surface, found ${files.length}`);
});

test("every tool has a description", () => {
  for (const file of files) {
    const description = descriptionOf(readFileSync(new URL(file, TOOL_DIR), "utf8"));
    assert.ok(description.length > 0, `${file} has no description`);
  }
});

test("no tool is described in one line", () => {
  // Under-description is the documented common failure, and it is invisible:
  // the tool works, it is just chosen at the wrong moments.
  for (const file of files) {
    const description = descriptionOf(readFileSync(new URL(file, TOOL_DIR), "utf8"));
    assert.ok(
      description.length >= 120,
      `${file}'s description is ${description.length} characters — say what it does AND when to use it`,
    );
  }
});

test("every tool says WHEN to use it, not only what it does", () => {
  // A trigger condition is what a model selects on. "Sends a message" describes
  // a function; "use it when the user asks you to send something" is the part
  // that decides whether this tool or another one gets called.
  // "This is the tool for X" is as much a trigger as "use it when X" — the
  // first version of this pattern rejected a description that named three
  // user phrasings verbatim, which is the clearest trigger in the codebase.
  // Widened twice while writing this, both times because a description stated
  // its trigger in a phrasing the pattern had not anticipated ("this is the
  // tool for X", "run it before X"). The check is for a stated trigger, not for
  // a house style — a pattern narrower than the language people actually write
  // in produces false failures and teaches everyone to ignore the test.
  const TRIGGER =
    /\b(use (it|this)|call (it|this)|run (it|this)|reach for|this is the tool for|when the user|whenever|use only|prefer)\b/i;

  for (const file of files) {
    const description = descriptionOf(readFileSync(new URL(file, TOOL_DIR), "utf8"));
    assert.match(
      description,
      TRIGGER,
      `${file} never says when to reach for it — add an explicit trigger condition`,
    );
  }
});

test("a tool that cannot be undone says so in its description", () => {
  // The model reads consequences out of the description too. These three are
  // the irreversible ones; if that fact lives only in a skill file, a turn that
  // never loads the skill has no way to know.
  const IRREVERSIBLE: Record<string, RegExp> = {
    "whatsapp_send_message.ts": /irreversible|cannot be undone|immediately/i,
    "whatsapp_revoke_message.ts": /delete|deleted/i,
    "whatsapp_send_voice.ts": /only when|do not/i,
  };

  for (const [file, expected] of Object.entries(IRREVERSIBLE)) {
    const description = descriptionOf(readFileSync(new URL(file, TOOL_DIR), "utf8"));
    assert.match(description, expected, `${file} must state its consequence in the description`);
  }
});
