import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

import { TOOLS, toolStatus, toolTally } from "../agent/lib/ui-tools.ts";

/**
 * The page that answers "can it actually do that right now".
 *
 * The drift guard below is the reason this file exists. The table in
 * `ui-tools.ts` is hand-written, because a tool's requirement lives in the
 * library it calls rather than in its own source — and a hand-written mirror of
 * a directory is exactly the artifact that silently falls behind. A tool added
 * without a row would simply not appear on the page, which reads as "this agent
 * cannot do that" rather than as a missing line in a table.
 */

const TOOL_DIR = new URL("../agent/tools/", import.meta.url);

const onDisk = readdirSync(TOOL_DIR)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => name.replace(/\.ts$/, ""))
  .sort();

test("the table covers exactly the tools that exist", () => {
  const listed = TOOLS.map((spec) => spec.tool).sort();

  const missing = onDisk.filter((tool) => !listed.includes(tool));
  const extra = listed.filter((tool) => !onDisk.includes(tool));

  assert.deepEqual(
    missing,
    [],
    `these tools exist but have no row in ui-tools.ts, so the UI would not show them: ${missing.join(", ")}`,
  );
  assert.deepEqual(
    extra,
    [],
    `these rows name tools that no longer exist: ${extra.join(", ")}`,
  );
});

test("no tool is listed twice", () => {
  const listed = TOOLS.map((spec) => spec.tool);
  assert.equal(new Set(listed).size, listed.length);
});

/* ── the three states ──────────────────────────────────────────────── */

test("a tool whose key is absent is dark, and says what it would have cost", () => {
  const statuses = toolStatus({});
  const search = statuses.find((s) => s.tool === "whatsapp_search_web")!;
  assert.equal(search.state, "dark");
  assert.match(search.reason, /Brave/);
  // The reason is a sentence, not a variable name: the page is read by someone
  // deciding whether to configure it, not by someone debugging it.
  assert.ok(search.reason.length > 30, search.reason);
});

test("either spelling of the search key lights it up", () => {
  assert.equal(
    toolStatus({ BRAVE_SEARCH_API_KEY: "k" }).find((s) => s.tool === "whatsapp_search_web")!.state,
    "live",
  );
});

test("any of the three ElevenLabs spellings lights up spoken replies", () => {
  // Honouring one spelling is a puzzle, not a safeguard — the same reasoning as
  // in speech.ts, asserted here so the page agrees with the tool.
  for (const key of ["ELEVENLABS_API_KEY", "ELEVEN_LABS_API_KEY", "XI_API_KEY"]) {
    const state = toolStatus({ [key]: "k" }).find((s) => s.tool === "whatsapp_send_voice")!.state;
    assert.equal(state, "live", `${key} should switch spoken replies on`);
  }
});

test("send is gated rather than dark: the tool is there, the bridge refuses", () => {
  const off = toolStatus({}).find((s) => s.tool === "whatsapp_send_message")!;
  assert.equal(off.state, "gated");
  assert.match(off.reason, /refuses|off/i);

  const on = toolStatus({ WA_ALLOW_SEND: "true" }).find((s) => s.tool === "whatsapp_send_message")!;
  assert.equal(on.state, "live");
  assert.equal(on.reason, "");
});

test("a gate is only open on a literal true", () => {
  for (const value of ["1", "yes", "TRUE ", ""]) {
    const state = toolStatus({ WA_ALLOW_SEND: value }).find(
      (s) => s.tool === "whatsapp_send_message",
    )!.state;
    const expected = value.trim().toLowerCase() === "true" ? "live" : "gated";
    assert.equal(state, expected, `WA_ALLOW_SEND=${JSON.stringify(value)}`);
  }
});

test("a missing key beats a closed gate, so the operator is sent to the right screen", () => {
  // whatsapp_send_image needs a model AND the send gate. With neither, the
  // honest answer is the model: opening the gate would change nothing.
  const status = toolStatus({}).find((s) => s.tool === "whatsapp_send_image")!;
  assert.equal(status.state, "dark");
});

test("the tally adds up to the tools that exist", () => {
  const tally = toolTally(toolStatus({ WA_ALLOW_SEND: "true" }));
  assert.equal(tally.total, onDisk.length);
  assert.equal(tally.live + tally.gated + tally.dark, tally.total);
});
