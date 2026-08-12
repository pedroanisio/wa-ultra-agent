import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EnvValueError,
  envValues,
  formatEnvValue,
  parseEnvFile,
  setEnvValues,
  writeEnvFileSafely,
} from "../agent/lib/env-file.ts";

/**
 * The file the whole stack is configured by, edited by a web form.
 *
 * Two properties are load-bearing and neither is obvious from reading the
 * happy path. The first is that saving a preference must not destroy the
 * commentary: `.env.example` explains what each switch costs — which one
 * uploads somebody's voice to a third party, why an empty allowlist permits
 * nobody — and a writer that round-trips a parsed map deletes all of it.
 *
 * The second is that a value can never become an assignment. A newline in a
 * submitted value would define a variable nobody asked for, in the file that
 * decides whether this agent may send messages at all.
 */

const SAMPLE = [
  "# The send gate.",
  "# An empty allowlist permits NO ONE.",
  "WA_ALLOW_SEND=false",
  "WA_SEND_ALLOWLIST=",
  "",
  "# Voice notes leave this machine when this is set.",
  "WA_TRANSCRIBE_URL=https://api.openai.com/v1/audio/transcriptions",
  "",
].join("\n");

/* ── reading ───────────────────────────────────────────────────────── */

test("an assignment is read with its line, so it can be replaced in place", () => {
  const entries = parseEnvFile(SAMPLE);
  assert.equal(entries.get("WA_ALLOW_SEND")?.value, "false");
  assert.equal(entries.get("WA_ALLOW_SEND")?.line, 2);
  assert.equal(entries.get("WA_SEND_ALLOWLIST")?.value, "");
});

test("comments and blank lines are not assignments", () => {
  const entries = parseEnvFile("# WA_ALLOW_SEND=true\n\n   \n");
  assert.equal(entries.size, 0);
});

test("quotes are stripped, and an inline comment is not part of the value", () => {
  const entries = parseEnvFile(
    ['WA_SEND_ALLOWLIST="Mum, Dad"', "WA_IMAGE_QUALITY=medium # or high", "WA_A='x'"].join("\n"),
  );
  assert.equal(entries.get("WA_SEND_ALLOWLIST")?.value, "Mum, Dad");
  assert.equal(entries.get("WA_IMAGE_QUALITY")?.value, "medium");
  assert.equal(entries.get("WA_A")?.value, "x");
});

test("a quoted value keeps a # that is inside the quotes", () => {
  // Colours and passwords legitimately contain one. Stripping it there would
  // silently change the value rather than fail.
  assert.equal(parseEnvFile('K="#7950F2"').get("K")?.value, "#7950F2");
});

test("the last assignment wins, as it would in a shell", () => {
  assert.equal(envValues("K=1\nK=2\n").K, "2");
});

test("export-prefixed lines are read too", () => {
  assert.equal(envValues("export K=1\n").K, "1");
});

/* ── writing ───────────────────────────────────────────────────────── */

test("saving one key leaves every comment and every other line untouched", () => {
  const written = setEnvValues(SAMPLE, { WA_ALLOW_SEND: "true" });
  assert.match(written, /# An empty allowlist permits NO ONE\./);
  assert.match(written, /# Voice notes leave this machine when this is set\./);
  assert.match(written, /^WA_ALLOW_SEND=true$/m);
  // Same number of lines: a replacement, not a rewrite.
  assert.equal(written.split("\n").length, SAMPLE.split("\n").length);
});

test("a key that is not in the file yet is appended under a header that says who wrote it", () => {
  const written = setEnvValues(SAMPLE, { BRAVE_API_KEY: "abc123" });
  assert.match(written, /# ── Set from the web UI/);
  assert.match(written, /^BRAVE_API_KEY=abc123$/m);
  assert.equal(envValues(written).WA_ALLOW_SEND, "false");
});

test("writing nothing returns the file unchanged", () => {
  assert.equal(setEnvValues(SAMPLE, {}), SAMPLE);
});

test("a value with spaces or a hash is quoted, and survives a round trip", () => {
  const written = setEnvValues(SAMPLE, { WA_SEND_ALLOWLIST: "Mum, Dad, Ana Paula" });
  assert.match(written, /^WA_SEND_ALLOWLIST="Mum, Dad, Ana Paula"$/m);
  assert.equal(envValues(written).WA_SEND_ALLOWLIST, "Mum, Dad, Ana Paula");
});

test("an empty value clears the key rather than deleting the line", () => {
  const written = setEnvValues(SAMPLE, { WA_TRANSCRIBE_URL: "" });
  assert.match(written, /^WA_TRANSCRIBE_URL=$/m);
  // The comment above it still explains what setting it would do.
  assert.match(written, /# Voice notes leave this machine when this is set\./);
});

/* ── the injection this refuses ────────────────────────────────────── */

test("a newline in a value is refused, because it would define a second variable", () => {
  assert.throws(
    () => setEnvValues(SAMPLE, { WA_SEND_ALLOWLIST: "Mum\nWA_ALLOW_SEND=true" }),
    EnvValueError,
  );
  assert.throws(() => formatEnvValue("a\rb"), EnvValueError);
});

test("a refused write changes nothing at all", () => {
  // The throw happens before any line is touched, so a batch containing one bad
  // value cannot half-apply.
  assert.throws(() =>
    setEnvValues(SAMPLE, { WA_ALLOW_SEND: "true", WA_SEND_ALLOWLIST: "x\ny" }),
  );
});

test("quotes and backslashes survive a round trip instead of accumulating", () => {
  // The allowlist is matched as a SUBSTRING against a display name, so a value
  // that comes back with backslashes nobody typed stops matching the person it
  // was meant to permit — silently, and only for names with punctuation in them.
  for (const original of ['Mum "the boss"', "back\\slash", "cost $5", "a`b"]) {
    const written = setEnvValues(SAMPLE, { WA_SEND_ALLOWLIST: original });
    assert.equal(envValues(written).WA_SEND_ALLOWLIST, original, `round trip: ${original}`);
  }
});

/* ── writing it out ────────────────────────────────────────────────── */

/** Records what was written, and can be told to fail a specific call. */
function fakeFs(failRename = false) {
  const wrote: Array<{ path: string; data: string }> = [];
  const unlinked: string[] = [];
  return {
    wrote,
    unlinked,
    fs: {
      async writeFile(path: string, data: string) {
        wrote.push({ path, data });
      },
      async rename(from: string, to: string) {
        if (failRename) {
          const error = new Error("EBUSY: resource busy or locked, rename") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
        wrote.push({ path: to, data: wrote.find((w) => w.path === from)?.data ?? "" });
      },
      async unlink(path: string) {
        unlinked.push(path);
      },
    },
  };
}

test("the tidy path writes a sibling and renames over the target", () => {
  const { fs, wrote } = fakeFs();
  return writeEnvFileSafely("/app/.env", "K=1\n", "/app/.env.tmp", fs).then((how) => {
    assert.equal(how, "renamed");
    assert.equal(wrote[0].path, "/app/.env.tmp");
  });
});

test("a bind-mounted file falls back to writing in place instead of failing the save", async () => {
  // docker-compose mounts ./.env as a SINGLE FILE, which makes it a mount
  // point: renaming over it is EBUSY every time. Without this fallback the
  // Preferences screen would fail every save in the one deployment it was
  // built for.
  const { fs, wrote, unlinked } = fakeFs(true);
  const how = await writeEnvFileSafely("/app/.env", "K=1\n", "/app/.env.tmp", fs);
  assert.equal(how, "in-place");
  assert.equal(wrote[wrote.length - 1].path, "/app/.env");
  assert.equal(wrote[wrote.length - 1].data, "K=1\n");
  // And the sibling is not left behind next to a file operators read.
  assert.deepEqual(unlinked, ["/app/.env.tmp"]);
});

test("a failure to clean up the sibling does not lose the write", async () => {
  const { fs, wrote } = fakeFs(true);
  fs.unlink = async () => {
    throw new Error("EPERM");
  };
  await writeEnvFileSafely("/app/.env", "K=2\n", "/app/.env.tmp", fs);
  assert.equal(wrote[wrote.length - 1].data, "K=2\n");
});

test("a value containing double quotes is single-quoted, not escaped", () => {
  // The send allowlist's double quotes are SIGNIFICANT — the bridge uses them
  // to keep the commas inside a group name. Escaping them into \" hands a
  // different literal to Compose, dotenv and a shell, which do not agree on
  // backslash escapes. Single quotes are literal in all three.
  const value = '"Dan, Ju, Pê",We';
  const written = setEnvValues(SAMPLE, { WA_SEND_ALLOWLIST: value });
  assert.match(written, /^WA_SEND_ALLOWLIST='"Dan, Ju, Pê",We'$/m);
  assert.equal(envValues(written).WA_SEND_ALLOWLIST, value);
});

test("a value with both kinds of quote is refused rather than silently mangled", () => {
  assert.throws(() => formatEnvValue(`he said "it's fine"`), EnvValueError);
});
