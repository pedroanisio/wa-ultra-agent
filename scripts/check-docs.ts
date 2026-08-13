/**
 * Assert the documentation still describes the code.
 *
 * ── Why these are CHECKS and not GENERATORS ──────────────────────────────────
 *
 * The obvious fix for a stale table is to generate it. Not here. The route
 * table in README.md and the tool sections in SPEC.md carry hand-written prose
 * — what each endpoint is FOR, which failure it prevents, why a default is what
 * it is — and none of that is derivable from the source. A generator would
 * replace explanation with enumeration, which is a worse document that happens
 * to be accurate.
 *
 * So each check below asserts COMPLETENESS and REFERENTIAL INTEGRITY, and
 * leaves the writing alone:
 *
 *   - every route the bridge AND the transport serve is documented somewhere,
 *   - every console command the user can type is in the README, and vice versa,
 *   - every dated report says whether its findings are still open,
 *   - every tool on disk is in the spec, and the spec names no tool that is not,
 *   - every config key the code reads appears in .env.example,
 *   - every path under agent/ that a document names is really on disk,
 *   - every npm script resolves to something that can run,
 *   - every human-facing document carries the disclaimer CLAUDE.md mandates.
 *
 * A failure prints exactly what is missing and exits non-zero. The prose stays
 * a human's job; only the drift is automated away.
 *
 * Run: `npm run docs:check`
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFile(join(ROOT, p), "utf8");

interface Failure {
  check: string;
  detail: string;
  items: string[];
  hint: string;
}

const failures: Failure[] = [];
const fail = (check: string, detail: string, items: string[], hint: string) => {
  if (items.length) failures.push({ check, detail, items, hint });
};

/* ------------------------------------------------------------------ *
 * 1. Bridge routes
 *
 * The bridge dispatches with a flat `path === "…"` chain, so the routes it
 * actually serves are extractable from that one file. Reading it in Node
 * rather than shelling out to grep matters: store.js and server.js contain a
 * NUL byte, which makes grep treat them as binary and silently find nothing.
 * ------------------------------------------------------------------ */
async function checkRoutes() {
  const server = await read("whatsapp-bridge/src/server.js");
  const actual = new Set([...server.matchAll(/path === "([^"]+)"/g)].map((m) => m[1]));

  // A route counts as documented if any shipped doc names it. The README's
  // table is the reference, but the transport setup guide legitimately owns
  // the pairing endpoints.
  const docs = await Promise.all(
    ["README.md", "SPEC.md", "HOWTO-TRANSPORT-SETUP.md"].map((f) => read(f)),
  );
  const corpus = docs.join("\n");

  const undocumented = [...actual]
    .filter((r) => !corpus.includes(r))
    .sort();

  fail(
    "routes",
    `${actual.size} routes served by the bridge, ${actual.size - undocumented.length} documented`,
    undocumented,
    "Document each in README.md's \"Bridge API\" table, or in HOWTO-TRANSPORT-SETUP.md if it is a pairing/setup endpoint.",
  );
}

/* ------------------------------------------------------------------ *
 * 1b. Transport routes
 *
 * The bridge's 47 were checked and the transport's 20 were not, which is worse
 * than checking neither: `docs:check` passing reads as "the route surface is
 * covered", and two thirds of a surface is not a surface. A new transport
 * endpoint was undocumented by default with nothing to say so.
 *
 * Go's ServeMux takes "METHOD /path" as one pattern string, which is why the
 * method comes along for free here and has to be split off before matching —
 * the docs write the path.
 * ------------------------------------------------------------------ */
async function checkTransportRoutes() {
  const api = await read("whatsapp-transport/internal/httpapi/api.go");
  const patterns = [...api.matchAll(/mux\.(?:Handle|HandleFunc)\("([A-Z]+ [^"]+)"/g)].map((m) => m[1]);

  const corpus = (
    await Promise.all(["README.md", "SPEC.md", "HOWTO-TRANSPORT-SETUP.md"].map((f) => read(f)))
  ).join("\n");

  // Path only. A doc that writes `POST /send/media` and one that writes it as a
  // row in a table with the method in its own column are both documentation;
  // demanding the method be adjacent would fail on the second and teach people
  // to write for the checker instead of the reader.
  const undocumented = patterns
    .filter((p) => !corpus.includes(p.slice(p.indexOf(" ") + 1)))
    .sort();

  fail(
    "routes:transport",
    `${patterns.length} routes served by the transport, ${patterns.length - undocumented.length} documented`,
    undocumented,
    "Document each in README.md or HOWTO-TRANSPORT-SETUP.md, which owns the pairing and outbox endpoints.",
  );

  // Guards the extraction itself. If someone moves registration out of api.go,
  // the loop above finds nothing and reports a clean surface — the exact
  // silent-pass this check exists to prevent.
  fail(
    "routes:transport",
    "no routes found in whatsapp-transport/internal/httpapi/api.go",
    patterns.length >= 15 ? [] : [`found ${patterns.length}, expected the full transport surface`],
    "The mux registration moved. Point this extraction at wherever it went, or the check silently passes forever.",
  );
}

/* ------------------------------------------------------------------ *
 * 1c. The console's command surface
 *
 * The highest-traffic surface in the system and the last one with no check:
 * `/menu`, `/game`, `/eve`, `/status`, `/noop`, `/quit` are what a person
 * literally types into WhatsApp. `/noop` was dispatched by the console and
 * documented nowhere at all.
 *
 * Both directions matter and the second is the sharper one. A command in the
 * docs that the console does not dispatch is a user typing something into their
 * own chat and getting silence back — and because the self chat is a notebook,
 * silence is exactly what an unrecognised line is SUPPOSED to produce. There is
 * no error to see.
 * ------------------------------------------------------------------ */
async function checkConsoleCommands() {
  const plugins = await read("whatsapp-bridge/src/plugins.js");
  const dispatched = [...plugins.matchAll(/^\s*command:\s*"(\/[a-z]+)"/gm)].map((m) => m[1]);

  // THE MENU BLOCK, not the whole README, and the distinction is load-bearing
  // in both directions. Searching the whole file lets a passing mention in prose
  // stand in for a menu entry — this check was written that way first, and it
  // sat green while `/noop` was missing from the menu, because a paragraph
  // further down happened to name it. A command absent from `/menu` is a command
  // nobody discovers, whatever else the README says about it. Searching the
  // whole file also picks up `/health` and `/status` from the HTTP route tables,
  // which are not console commands at all.
  const readme = await read("README.md");
  const fence = /```\n📋 \*What I can do here\*[\s\S]*?```/.exec(readme);
  if (!fence) {
    fail(
      "console:menu",
      "the README's console menu block could not be found",
      ["expected a fenced block opening with 📋 *What I can do here*"],
      "The menu moved or was reworded. Point this extraction at it — until then both console checks below are vacuous.",
    );
    return;
  }
  const menu = new Set([...fence[0].matchAll(/`(\/[a-z]+)`/g)].map((m) => m[1]));

  fail(
    "console:undocumented",
    `${dispatched.length} console commands dispatched, ${dispatched.filter((c) => menu.has(c)).length} in the README's menu`,
    dispatched.filter((c) => !menu.has(c)).sort(),
    "Add each to README.md's console menu block. This is the surface the user types into; a command that is not in the menu is one nobody will ever discover.",
  );

  fail(
    "console:phantom",
    "commands the README's menu offers that the console does not dispatch",
    [...menu].filter((c) => !dispatched.includes(c)).sort(),
    "Remove it from the menu or add it to PLUGINS. A command that does nothing returns silence, and silence is what an ordinary note returns too.",
  );

  fail(
    "console:phantom",
    "no commands found in whatsapp-bridge/src/plugins.js",
    dispatched.length >= 4 ? [] : [`found ${dispatched.length}, expected the full console surface`],
    "The PLUGINS shape changed. Point this extraction at it, or both checks above silently pass forever.",
  );
}

/* ------------------------------------------------------------------ *
 * 1d. Reports say whether they are still true
 *
 * `reports/` holds dated forensic artifacts — a surface-gap audit, two hygiene
 * passes, a corpus study. Their findings get FIXED, usually within a day here,
 * and a reader who opens one afterwards meets a blocker-severity table with
 * nothing to say every item is closed. Two of the three were in exactly that
 * state.
 *
 * The check is not "is it accurate" — nothing static can tell. It is "does it
 * say, near the top, what it still claims to be".
 * ------------------------------------------------------------------ */
const REPORT_STATUS = /\*\*(CLOSED|RESOLVED|OPEN|SNAPSHOT|SUPERSEDED|SUPERSEDES|IN PROGRESS)\b/i;

async function checkReportStatus() {
  const offenders: string[] = [];
  for await (const file of walk(join(ROOT, "reports"))) {
    if (!file.endsWith(".md")) continue;
    const head = (await readFile(file, "utf8")).split("\n").slice(0, 45).join("\n");
    if (!REPORT_STATUS.test(head)) offenders.push(file.slice(ROOT.length));
  }

  fail(
    "reports:status",
    "dated reports with no status marker in their first 45 lines",
    offenders.sort(),
    "Open with a bold **CLOSED** / **RESOLVED** / **OPEN** / **SNAPSHOT** line saying what is still true and, if closed, which commits closed it. A finished audit read as an open one costs somebody an afternoon.",
  );
}

/* ------------------------------------------------------------------ *
 * 2. Agent tools
 *
 * Both directions matter, and the second is the dangerous one: a spec that
 * NAMES A TOOL THAT DOES NOT EXIST tells an operator a capability is there
 * when nothing implements it.
 * ------------------------------------------------------------------ */
async function checkTools() {
  const files = await readdir(join(ROOT, "agent/tools"));
  const onDisk = new Set(
    files.filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, "")),
  );

  // Only the part of the spec that describes what EXISTS. Everything from the
  // roadmap onward is deliberately about what does not — §8 proposes a
  // `whatsapp_merge_arcs` that may never be built, and naming a hypothetical in
  // a section titled "Open decisions" is correct writing, not a phantom. Cutting
  // there keeps both directions of this check honest: a tool named only in the
  // roadmap must not count as documented either.
  const full = await read("SPEC.md");
  const forwardLooking = full.search(/^## 7\. Roadmap/m);
  const spec = forwardLooking === -1 ? full : full.slice(0, forwardLooking);

  // A line that explicitly disclaims a tool is not claiming it. Recording that
  // a name was proposed and rejected is worth more than silently dropping it —
  // the next reader would otherwise re-propose it — so naming it here has to
  // stay legal.
  const DISCLAIMED = /never built|not built|does not exist|not planned|was removed/i;
  const named = new Set(
    spec
      .split("\n")
      .filter((line) => !DISCLAIMED.test(line))
      .flatMap((line) => [...line.matchAll(/whatsapp_[a-z_]+/g)].map((m) => m[0])),
  );

  fail(
    "tools:missing",
    `${onDisk.size} tools on disk, ${[...onDisk].filter((t) => named.has(t)).length} named in SPEC.md`,
    [...onDisk].filter((t) => !named.has(t)).sort(),
    "Add each to SPEC.md. A tool the spec omits is a capability nobody knows exists.",
  );

  fail(
    "tools:phantom",
    "tool names in SPEC.md with no implementation",
    [...named].filter((t) => !onDisk.has(t)).sort(),
    "Remove these from SPEC.md, or build them. Documenting a tool that does not exist is worse than omitting one.",
  );
}

/* ------------------------------------------------------------------ *
 * 3. Config keys
 *
 * Matched by literal NAME across all sources, not by `process.env.X`. This
 * codebase overwhelmingly threads `env` as a parameter — `parseAllowlist(env =
 * process.env)` — so a `process.env`-only scan reports about twenty real keys
 * as phantoms. That false positive is the reason this function looks the way
 * it does.
 * ------------------------------------------------------------------ */

/**
 * Set by the OS or the runtime, not by this project. Not ours to document.
 *
 * Deliberately short. `PORT` and `TMPDIR` were on this list and should not have
 * been: the bridge reads PORT as its listen port, and TMPDIR decides where
 * generated images are staged on disk — which is a privacy question, not an
 * environment detail. A name looking system-ish is not the test; whether THIS
 * project reads it to make a decision is.
 */
const SYSTEM_VARS = new Set(["NODE_ENV", "HOME", "PATH"]);

async function checkEnv() {
  const sources: string[] = [];
  for (const dir of ["agent", "whatsapp-bridge/src", "whatsapp-transport", "test"]) {
    for await (const file of walk(join(ROOT, dir))) {
      if (/\.(ts|js|go)$/.test(file)) sources.push(await readFile(file, "utf8"));
    }
  }
  // Comments are stripped first. A key named in prose is not a key the runtime
  // reads — a JSDoc line saying "every `process.env.NAME` the runtime reads"
  // would otherwise demand that `.env.example` document a variable called NAME.
  // Conservative on purpose: whole comment lines and block comments only, so a
  // `//` inside a URL string cannot swallow real code after it.
  const corpus = sources
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|#)/.test(line))
    .join("\n");

  // Every plausible read form, then filtered to names this project owns.
  const keys = new Set<string>([
    ...[...corpus.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
    ...[...corpus.matchAll(/process\.env\[["'`]([A-Z][A-Z0-9_]+)["'`]\]/g)].map((m) => m[1]),
    ...[...corpus.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
    ...[...corpus.matchAll(/os\.Getenv\("([A-Z][A-Z0-9_]+)"\)/g)].map((m) => m[1]),
  ]);

  const example = await read(".env.example");

  // A DEFINITION, not a mention. `example.includes(k)` was the first version of
  // this and it passed on prose — OPENAI_API_KEY appeared twice in sentences
  // explaining what needs it and was never actually defined, so an operator
  // copying the file got an installation missing transcription, image
  // generation and speech with nothing to tell them why. A definition starts
  // the line; an indented `#   KEY=value` inside a comment is an example.
  const defined = new Set(
    [...example.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]),
  );

  fail(
    "env:undocumented",
    `${keys.size} config keys read in code, ${defined.size} defined in .env.example`,
    [...keys].filter((k) => !SYSTEM_VARS.has(k) && !defined.has(k)).sort(),
    "Add each to .env.example WITH the prose that file uses — what it is for and what happens when it is unset. A bare key is not documentation.",
  );

  // Two definitions of one key means the second silently wins, and the prose
  // above the first is then a lie about the running value.
  const counts = new Map<string, number>();
  for (const [, k] of example.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)) {
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  fail(
    "env:duplicate",
    "keys defined more than once in .env.example",
    [...counts].filter(([, n]) => n > 1).map(([k, n]) => `${k} (${n}×)`).sort(),
    "Keep one definition. Cross-reference the other place rather than repeating the assignment.",
  );
}

/* ------------------------------------------------------------------ *
 * 5. Skills and schedules name real tools
 *
 * Stricter than the SPEC check, because these files are loaded into the model's
 * context AS PROCEDURE. A spec that names a missing tool misleads a reader; a
 * skill that names one instructs the model to call nothing.
 * ------------------------------------------------------------------ */
async function checkSkillTools() {
  const files = await readdir(join(ROOT, "agent/tools"));
  const onDisk = new Set(
    files.filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, "")),
  );
  const DISCLAIMED = /no `?whatsapp_|there is no|never built|not built|does not exist|used to describe/i;

  const offences: string[] = [];
  for (const dir of ["agent/skills", "agent/schedules"]) {
    for await (const file of walk(join(ROOT, dir))) {
      if (!file.endsWith(".md")) continue;
      const rel = file.slice(ROOT.length).replace(/^\//, "");
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (DISCLAIMED.test(line)) return;
        for (const [name] of line.matchAll(/whatsapp_[a-z_]+/g)) {
          if (!onDisk.has(name)) offences.push(`${rel}:${i + 1} names ${name}`);
        }
      });
    }
  }

  fail(
    "skills",
    "procedure files naming a tool that does not exist",
    [...new Set(offences)].sort(),
    "A skill is loaded as procedure, so this tells the model to call nothing. Fix the name, or say plainly that the tool does not exist.",
  );
}

/* ------------------------------------------------------------------ *
 * 6. Documented commands actually run
 * ------------------------------------------------------------------ */
async function checkScripts() {
  const pkg = JSON.parse(await read("package.json"));
  const offences: string[] = [];

  for (const [name, cmd] of Object.entries<string>(pkg.scripts ?? {})) {
    // `cd <dir> && npm run <script>` / `npm start` — verify the target exists.
    const delegated = /cd\s+(\S+)\s+&&\s+npm\s+(?:run\s+(\S+)|(start|test))/.exec(cmd);
    if (delegated) {
      const [, dir, runScript, builtin] = delegated;
      const target = runScript ?? builtin;
      try {
        const child = JSON.parse(await read(join(dir, "package.json")));
        if (!child.scripts?.[target]) {
          offences.push(
            `${name} → ${dir} has no script "${target}" (has: ${Object.keys(child.scripts ?? {}).join(", ")})`,
          );
        }
      } catch {
        offences.push(`${name} → ${dir}/package.json is unreadable`);
      }
    }

    // `node scripts/x.ts` — verify the file is there.
    const local = /node\s+(scripts\/[\w.-]+)/.exec(cmd);
    if (local) {
      try {
        await readFile(join(ROOT, local[1]));
      } catch {
        offences.push(`${name} → ${local[1]} does not exist`);
      }
    }
  }

  fail(
    "scripts",
    "npm scripts that cannot run",
    offences.sort(),
    "Fix the command or remove the script. A documented command that fails is worse than an undocumented one.",
  );
}

/* ------------------------------------------------------------------ *
 * 3b. Paths into agent/ that documentation names
 *
 * Tools were already covered both ways; skills and schedules were not, and the
 * gap was not theoretical. `README.md` described "a scheduled tic-tac-toe
 * (`ttt`, `agent/schedules/tictactoe.md`)" and the coordination dance between
 * it and the bridge console — a file that does not exist, for a five-minute
 * schedule that `agent/skills/tictactoe/SKILL.md` says was retired for posting
 * the same board twice. It survived a surface-gap audit and a doc-hygiene pass
 * because both checked tools, routes and config keys, and a schedule is none of
 * those.
 *
 * The rule generalises past this one case: `agent/` is a manifest directory —
 * eve registers what is on disk — so any `agent/<kind>/<name>` a document names
 * is a claim about the built manifest, and it is checkable by looking.
 * ------------------------------------------------------------------ */
async function checkAgentPaths() {
  const docs: Array<[string, string]> = [];
  for await (const file of walk(join(ROOT, "agent"))) {
    if (file.endsWith(".md")) docs.push([file.slice(ROOT.length), await readFile(file, "utf8")]);
  }
  for (const rel of ["README.md", "SPEC.md", "HOWTO-TRANSPORT-SETUP.md", "CLAUDE.md"]) {
    docs.push([rel, await read(rel)]);
  }

  // A line may name a path while saying it is gone — that is how the removal of
  // anything gets explained. Same allowance the ACL prose guards make.
  const DISCLAIMED = /\b(remove\w*|delete\w*|gone|retired?|no longer|used to|superseded?|does not exist|never built)\b|~~/i;

  const offences: string[] = [];
  for (const [rel, body] of docs) {
    body.split("\n").forEach((line, i) => {
      if (DISCLAIMED.test(line)) return;
      for (const [, ref] of line.matchAll(/`(agent\/(?:schedules|skills|tools|hooks|channels|connections)\/[\w./-]+)`/g)) {
        if (!existsSync(join(ROOT, ref))) offences.push(`${rel}:${i + 1} names ${ref}`);
      }
    });
  }

  fail(
    "agent-paths",
    "documented paths under agent/ that are not on disk",
    [...new Set(offences)].sort(),
    "Build it, correct the path, or say on that line that it was removed. eve registers what is on disk, " +
      "so a path here is a claim about the manifest.",
  );
}

/* ------------------------------------------------------------------ *
 * 4. Frontmatter disclaimer (CLAUDE.md §5)
 *
 * Exemptions are not laziness. A SKILL.md, a schedule and instructions.md all
 * carry frontmatter the eve runtime PARSES, or are loaded verbatim into a
 * model's prompt. A prose disclaimer in those is inert at best and a parse
 * hazard at worst, and it informs no human — nobody reads a schedule's
 * frontmatter. CLAUDE.md §5 records this exemption explicitly.
 * ------------------------------------------------------------------ */
const FRONTMATTER_EXEMPT = [
  /^agent\/skills\/.+\/SKILL\.md$/, // eve parses name/description
  /^agent\/schedules\/.+\.md$/, //     eve parses cron/prompt
  /^agent\/instructions\.md$/, //      loaded verbatim as the system prompt
  /^\.doc-quarantine\//, //            retired; frozen as found
  /^reports\//, //                     point-in-time artifacts carry their own headers
];

async function checkFrontmatter() {
  const offenders: string[] = [];
  for await (const file of walk(join(ROOT))) {
    if (!file.endsWith(".md")) continue;
    const rel = file.slice(ROOT.length).replace(/^\//, "");
    if (rel.includes("node_modules/") || rel.startsWith(".")) continue;
    if (FRONTMATTER_EXEMPT.some((re) => re.test(rel))) continue;

    const head = (await readFile(file, "utf8")).slice(0, 600);
    if (!/^---\r?\n[\s\S]*?disclaimer:/.test(head)) offenders.push(rel);
  }

  fail(
    "frontmatter",
    "human-facing documents missing the disclaimer block CLAUDE.md §5 mandates",
    offenders.sort(),
    "Add the disclaimer frontmatter, or add a rule to FRONTMATTER_EXEMPT here if the file is parsed by a runtime.",
  );
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory absent — nothing to check
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else yield full;
  }
}

/* ------------------------------------------------------------------ */

await checkRoutes();
await checkTransportRoutes();
await checkConsoleCommands();
await checkReportStatus();
await checkTools();
await checkSkillTools();
await checkAgentPaths();
await checkEnv();
await checkScripts();
await checkFrontmatter();

if (failures.length === 0) {
  console.log("docs:check — the documentation matches the code.");
  process.exit(0);
}

console.error("docs:check FAILED\n");
for (const f of failures) {
  console.error(`  [${f.check}] ${f.detail}`);
  for (const item of f.items) console.error(`      · ${item}`);
  console.error(`    → ${f.hint}\n`);
}
console.error(
  `${failures.reduce((n, f) => n + f.items.length, 0)} problems across ${failures.length} checks.`,
);
process.exit(1);
