import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Two promises the documentation makes that no compiler and no reader checks.
 *
 * ── Why these two, and not the others ───────────────────────────────────────
 *
 * A surface-gap audit of this repository found zero fake, stubbed or missing
 * *code* — every tool, route and script resolved to real I/O — and five gaps in
 * the surrounding prose. Four of the five were one defect wearing four hats: the
 * browser-based architecture was deleted from the code and left standing in the
 * documentation that described it.
 *
 * Most of what that audit asked for now lives in `scripts/check-docs.ts`, which
 * runs in CI before this suite: every bridge route documented, every tool named
 * in the spec and every name in the spec a real tool, every config key the code
 * reads defined in `.env.example` and defined only once. That file is the better
 * home for those checks — it walks the tree properly and reports what drifted
 * rather than which assertion failed. Nothing here duplicates it.
 *
 * What is left are the two the audit found that a completeness check cannot
 * express, because both are about a claim being FALSE rather than missing:
 *
 *   1. A developer command that resolves to nothing. `npm run bridge:dev`
 *      delegated to a `start:xvfb` script that went with the Xvfb-hosted
 *      browser; it failed unconditionally, on every platform, and no test could
 *      notice because a broken npm script is data in a JSON file.
 *
 *   2. Documentation describing the browser path as if it still ran. The README
 *      recorded that `src/selectors.js` was deleted and then, 469 lines later,
 *      explained its selector-degradation strategy and its `503` diagnostic in
 *      the present tense — inside `## Known limits`, the section an operator
 *      reads precisely when archiving is failing and they need a true failure
 *      model. `docker-compose.yml` told them an unconfigured transport left the
 *      bridge "reading the DOM exactly as before", which would have shipped a
 *      stack that silently received nothing.
 *
 * `whatsapp-bridge/test/anti-corruption-layer.test.js` asserts the same thing
 * about the bridge's code and its comments. This is the prose half.
 */

const ROOT = new URL("../", import.meta.url);
const path = (rel: string) => fileURLToPath(new URL(rel, ROOT));
const read = (rel: string) => readFileSync(path(rel), "utf8");
const exists = (rel: string) => {
  try {
    statSync(path(rel));
    return true;
  } catch {
    return false;
  }
};

/* ── 1. Every developer command resolves ───────────────────────────────────*/

test("every npm script resolves to something that exists", () => {
  const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts ?? {};
  const broken: string[] = [];

  for (const [name, command] of Object.entries(scripts)) {
    const delegated = command.match(/cd\s+(\S+)\s*&&\s*npm(?:\s+run)?\s+([\w:-]+)/);
    if (delegated) {
      const [, dir, target] = delegated;
      const manifest = `${dir}/package.json`;
      if (!exists(manifest)) {
        broken.push(`${name} → ${manifest} does not exist`);
        continue;
      }
      const theirs: Record<string, string> = JSON.parse(read(manifest)).scripts ?? {};
      if (!(target in theirs)) {
        broken.push(`${name} → ${dir} has no script "${target}" (it has: ${Object.keys(theirs).join(", ")})`);
      }
      continue;
    }

    // A script that runs a checked-in file rather than a binary on PATH. Both
    // halves matter: `transport:dev` is a shell script in this repository, and a
    // file that lost its execute bit fails exactly like a missing one.
    const [first] = command.split(/\s+/);
    if (!first.includes("/")) continue;
    if (!exists(first)) {
      broken.push(`${name} → ${first} does not exist`);
      continue;
    }
    try {
      accessSync(path(first), constants.X_OK);
    } catch {
      broken.push(`${name} → ${first} is not executable`);
    }
  }

  assert.deepEqual(broken, [], `npm scripts that cannot run:\n${broken.join("\n")}`);
});

test("the scripts this checks against are really there", () => {
  // Guard against the check above passing because the manifest parsed to nothing.
  const scripts = JSON.parse(read("package.json")).scripts ?? {};
  assert.ok(Object.keys(scripts).length > 5, "expected the real script surface");
  assert.ok("test" in scripts && "typecheck" in scripts);
});

/* ── 2. The browser is gone, in the prose as well as the code ──────────────*/

/** Documentation an operator or the model reads. Reports and drafts promise nothing. */
function shippedDocs(): string[] {
  const docs = [
    "README.md",
    "SPEC.md",
    "docker-compose.yml",
    ".env.example",
    "HOWTO-TRANSPORT-SETUP.md",
    "agent/instructions.md",
  ];
  for (const dir of readdirSync(path("agent/skills"), { withFileTypes: true })) {
    if (dir.isDirectory() && exists(`agent/skills/${dir.name}/SKILL.md`)) {
      docs.push(`agent/skills/${dir.name}/SKILL.md`);
    }
  }
  for (const name of readdirSync(path("agent/schedules"))) {
    if (name.endsWith(".md")) docs.push(`agent/schedules/${name}`);
  }
  return docs.filter(exists);
}

/** Modules deleted with the Playwright path. Named individually, as in the ACL test. */
const DEPARTED = /\b(session|selectors|lifecycle|watch)\.js\b/;

/** Claiming the DOM is still a source of messages, in a tense that reads as present. */
const DOM_AS_SOURCE = /\b(read|reads|reading|scrape|scrapes|scraping|walk|walks|walking)\b[^.\n]{0,40}\bDOM\b/i;

/**
 * What turns a mention into history.
 *
 * The rule is not "never mention the browser" — its removal is the single most
 * important thing this repository has to explain, and a document that cannot
 * name what it removed cannot explain it. The rule is that a mention must say it
 * is gone. Deliberately generous, and widened twice while writing this: a check
 * narrower than the language people actually write in produces false failures
 * and teaches everyone to ignore the test.
 */
const REMOVAL_MARKER =
  /\b(remove\w*|delete\w*|gone|went with|no longer|supersed\w*|replac\w*|used to|once\b|obsolete|historical|predates?|was|were)\b|~~/i;

test("no document presents the deleted browser path as live architecture", () => {
  const offences: string[] = [];

  for (const file of shippedDocs()) {
    const lines = read(file).split("\n");
    lines.forEach((line, i) => {
      if (!DEPARTED.test(line) && !DOM_AS_SOURCE.test(line)) return;
      // History reads across a couple of lines, so accept a marker just above.
      const window = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
      if (REMOVAL_MARKER.test(window)) return;
      offences.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offences,
    [],
    "A document describes the browser path as if it still ran. It was deleted: reception, " +
      "sending, media and history all go through whatsapp-transport, and the bridge is inert " +
      "without one. Say so, or say plainly that the mention is history:\n" + offences.join("\n"),
  );
});

test("the documents this reads are really there", () => {
  const docs = shippedDocs();
  assert.ok(docs.length > 8, `expected the shipped documentation set, found ${docs.length}`);
  assert.ok(docs.includes("README.md") && docs.includes("docker-compose.yml"));
});

/* ── 3. No knob that nothing reads ─────────────────────────────────────────*/

/**
 * Consumed by an image this repository does not build.
 *
 * The only legitimate reason for a variable here to be unread by this tree.
 * `FRAMEFORGE_MCP_SESSION_ROOT` is the renderer's own setting, restated in
 * Compose because the agent's `WA_FRAMEFORGE_SESSION_ROOT` must agree with it
 * exactly — the agreement is the reason it appears, and it is the third-party
 * process that reads it.
 */
const FOREIGN_VARS = new Set(["FRAMEFORGE_MCP_SESSION_ROOT", "FRAMEFORGE_HTTP_ALLOW_ANY"]);

test("no service is handed a setting nothing reads", () => {
  // `WA_QUIET_HOURS` was passed to the bridge with a comment promising that
  // "inside it the bridge reads nothing and reports nothing". Nothing had read
  // it since the rationing subsystem went with the browser, so an operator could
  // set quiet hours, believe the agent could not message them overnight, and be
  // wrong. A knob that does nothing is worse than a missing one: the missing one
  // cannot be trusted.
  const compose = read("docker-compose.yml");
  const declared = [...compose.matchAll(/^\s{4,}([A-Z][A-Z0-9_]{3,}):\s/gm)].map((m) => m[1]);

  const sources = ["agent", "whatsapp-bridge/src", "whatsapp-transport", "test", "scripts"]
    .filter(exists)
    .flatMap((dir) => filesUnder(dir))
    .filter((f) => /\.(ts|js|go)$/.test(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  const unread = [...new Set(declared)]
    .filter((key) => !FOREIGN_VARS.has(key))
    .filter((key) => !new RegExp(`\\b${key}\\b`).test(sources))
    .sort();

  assert.deepEqual(
    unread,
    [],
    `docker-compose.yml passes settings that no code reads: ${unread.join(", ")}. ` +
      "Remove the key, or implement what its comment promises.",
  );
});

/** Every file under `rel`, recursively. */
function filesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(path(rel));
  return out;
}
