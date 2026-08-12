import { test } from "node:test";
import assert from "node:assert/strict";

import { envValues } from "../agent/lib/env-file.ts";
import {
  SETTINGS,
  SettingRefused,
  applySettings,
  maskSecret,
  settingSpec,
  validateSetting,
} from "../agent/lib/ui-settings.ts";

/**
 * The boundary around a web form that rewrites the stack's configuration.
 *
 * The interesting assertions here are the negative ones. This UI can write
 * `.env`, and `.env` decides whether a live WhatsApp account may send messages,
 * where voice notes are uploaded, and which bridge the agent trusts. So the
 * test that matters most is that the credentials guarding all of that are NOT
 * in the writable set — a property that would otherwise decay the first time
 * somebody added "just one more field" to the form.
 */

/* ── what may never be written from a browser ──────────────────────── */

test("no credential that authenticates this UI or its services is editable", () => {
  const FORBIDDEN = [
    // Guards the UI itself: a UI that can rotate this can lock its owner out.
    "WA_UI_PASSWORD",
    "WA_UI_USERNAME",
    // Guards the archive and the account behind it.
    "WA_BRIDGE_TOKEN",
    "WA_TRANSPORT_TOKEN",
    "WA_CONSOLE_PUSH_TOKEN",
    // Points the agent at a bridge. Editable means "point it somewhere else".
    "WA_BRIDGE_URL",
    "WA_TRANSPORT_URL",
    "WA_AGENT_URL",
    // The model provider's own credentials.
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ];

  for (const key of FORBIDDEN) {
    assert.equal(settingSpec(key), undefined, `${key} must not be editable from the web UI`);
  }
});

test("an unknown key is refused rather than appended", () => {
  assert.throws(() => applySettings("", { WA_BRIDGE_TOKEN: "stolen" }), SettingRefused);
  assert.throws(() => applySettings("", { PATH: "/tmp" }), SettingRefused);
});

test("every editable setting says what the value costs, not just what it is", () => {
  // A row without this sentence is a row somebody sets wrongly: none of these
  // switches state their consequence in their name.
  for (const spec of SETTINGS) {
    assert.ok(spec.note.length >= 40, `${spec.key} needs a note explaining the consequence`);
    assert.ok(spec.restarts, `${spec.key} must say which service reads it at boot`);
  }
});

/* ── validation ────────────────────────────────────────────────────── */

test("the send gate takes only true or false", () => {
  const spec = settingSpec("WA_ALLOW_SEND")!;
  assert.deepEqual(validateSetting(spec, "true"), { ok: true, value: "true" });
  assert.equal(validateSetting(spec, "yes").ok, false);
  assert.equal(validateSetting(spec, "").ok, false);
});

test("an empty allowlist is valid, because permitting nobody is a real setting", () => {
  const spec = settingSpec("WA_SEND_ALLOWLIST")!;
  assert.deepEqual(validateSetting(spec, ""), { ok: true, value: "" });
});

test("a quoted allowlist entry survives verbatim, commas and all", () => {
  // The bridge's own splitter treats a double-quoted entry as ONE name, so that
  // a group called "Dan, Ju, Pê" is one permission. Re-splitting it on every
  // comma shatters it into three entries — none of which match that group,
  // while each becomes a standing permission of its own. The send boundary is
  // not something a rendering pass may reformat.
  const spec = settingSpec("WA_SEND_ALLOWLIST")!;
  const real = '"Pedro Anisio Silva","Dan, Ju, Pê",We';
  assert.deepEqual(validateSetting(spec, real), { ok: true, value: real });
});

test("an unclosed quote in the allowlist is refused", () => {
  // It silently swallows the rest of the list into a single entry, which is a
  // permission nobody granted.
  const spec = settingSpec("WA_SEND_ALLOWLIST")!;
  assert.equal(validateSetting(spec, '"Dan, Ju, Pê,We').ok, false);
});

test("a stray comma in a plain list is refused, not silently dropped", () => {
  const spec = settingSpec("WA_SEARCH_COUNTRY")!;
  assert.equal(spec.kind === "list" ? validateSetting(spec, "a,,b").ok : false, false);
});

test("a retention window is a whole number of days, or blank for for ever", () => {
  const spec = settingSpec("WA_RETAIN_MESSAGE_DAYS")!;
  assert.deepEqual(validateSetting(spec, "730"), { ok: true, value: "730" });
  assert.deepEqual(validateSetting(spec, "0"), { ok: true, value: "0" });
  assert.deepEqual(validateSetting(spec, ""), { ok: true, value: "" });
  // The file treats a negative as "for ever" so a typo cannot delete an
  // archive. In a box labelled "keep for", a typed -1 is a mistake to report.
  assert.equal(validateSetting(spec, "-1").ok, false);
  assert.equal(validateSetting(spec, "730 days").ok, false);
});

test("a transcription endpoint must be a real http URL", () => {
  const spec = settingSpec("WA_TRANSCRIBE_URL")!;
  assert.equal(validateSetting(spec, "http://127.0.0.1:8080/v1/audio/transcriptions").ok, true);
  assert.equal(validateSetting(spec, "").ok, true);
  assert.equal(validateSetting(spec, "api.openai.com/v1").ok, false);
  assert.equal(validateSetting(spec, "file:///etc/passwd").ok, false);
});

test("only models the registry has measured can be chosen", () => {
  const spec = settingSpec("WA_MODEL_ID")!;
  assert.equal(validateSetting(spec, "gpt-5.6-luna").ok, true);
  // Unmeasured is worse than unsupported: every guard here is a fraction of the
  // context window, so an unknown model leaves them sized for a different one.
  assert.equal(validateSetting(spec, "gpt-6-imaginary").ok, false);
});

/* ── applying ──────────────────────────────────────────────────────── */

test("a valid batch is written into the file, comments intact", () => {
  const before = ["# The send gate.", "WA_ALLOW_SEND=false", "WA_SEND_ALLOWLIST=", ""].join("\n");
  const after = applySettings(before, {
    WA_ALLOW_SEND: "true",
    WA_SEND_ALLOWLIST: '"Dan, Ju, Pê",We',
  });
  assert.match(after, /# The send gate\./);
  assert.equal(envValues(after).WA_ALLOW_SEND, "true");
  // Byte for byte what was submitted: the quoting is the bridge's grammar.
  assert.equal(envValues(after).WA_SEND_ALLOWLIST, '"Dan, Ju, Pê",We');
});

test("every setting with a default declares it, so unset is never shown as a value", () => {
  // WA_ALLOW_SELF_NOTE unset means TRUE. A page that renders that as `false` is
  // showing the opposite of what is running.
  assert.equal(settingSpec("WA_ALLOW_SELF_NOTE")!.defaultValue, "true");
  assert.equal(settingSpec("WA_ALLOW_SEND")!.defaultValue, "false");
});

test("one bad value refuses the whole batch", () => {
  // The failure this prevents: a save that widens the allowlist and then fails
  // to apply the switch that was meant to keep it shut.
  const before = "WA_ALLOW_SEND=false\nWA_SEND_ALLOWLIST=\n";
  assert.throws(
    () => applySettings(before, { WA_SEND_ALLOWLIST: "Mum", WA_ALLOW_SEND: "perhaps" }),
    SettingRefused,
  );
});

test("a secret is reported by its shape, never by its value", () => {
  assert.equal(maskSecret(""), "");
  const masked = maskSecret("sk-live-4321");
  assert.equal(masked, "set · 12 characters");
  assert.ok(!masked.includes("4321"));
});
