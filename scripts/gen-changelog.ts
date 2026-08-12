/**
 * Build CHANGELOG.md from the commit history.
 *
 * ── Why not git-cliff ───────────────────────────────────────────────────────
 *
 * Because the input is already good. Every commit here follows Conventional
 * Commits and the subjects are written as sentences a person would say — "a
 * turn that dies now says so, instead of leaving the chat silent" — so the
 * grouping is the only thing missing, and that is thirty lines. Adding a Rust
 * binary and a `cliff.toml` to a repo with no other build dependency buys
 * configurability nobody has asked for, against CLAUDE.md's "no unnecessary
 * dependencies".
 *
 * Sections are ordered by what a reader cares about, not alphabetically, and a
 * type nobody uses simply does not appear.
 *
 * Run: `npm run changelog` — writes CHANGELOG.md. Re-runnable; it regenerates
 * the whole file from history, so never hand-edit it.
 */

import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

/** Conventional-commit type → heading. Order here is the order in the file. */
const SECTIONS: Array<[string, string]> = [
  ["feat", "Added"],
  ["fix", "Fixed"],
  ["perf", "Performance"],
  ["refactor", "Changed"],
  ["docs", "Documentation"],
  ["test", "Tests"],
  ["build", "Build"],
  ["ci", "CI"],
  ["chore", "Chores"],
];

interface Commit {
  type: string;
  scope?: string;
  subject: string;
  sha: string;
  breaking: boolean;
}

const commits: Commit[] = git("log", "--format=%H\t%s")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [sha, subject] = line.split("\t");
    const m = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
    if (!m) return { type: "other", subject, sha, breaking: false };
    return { type: m[1], scope: m[2], subject: m[4], sha, breaking: Boolean(m[3]) };
  });

// A tag is a release boundary. With none, everything is unreleased — which is
// the honest label for a 0.0.0 package, rather than inventing a version.
const tags = git("tag", "--list").split("\n").filter(Boolean);
const version = tags.length ? tags[tags.length - 1] : "Unreleased";
const date = git("log", "-1", "--format=%ad", "--date=short");

const lines: string[] = [
  "---",
  "disclaimer:",
  "  notice: >-",
  "    No information within this document should be taken for granted.",
  "    Any statement or premise not backed by a real logical definition",
  "    or verifiable reference may be invalid, erroneous, or a hallucination.",
  '  generated_by: "scripts/gen-changelog.ts (from Conventional Commit subjects)"',
  `  date: "${date}"`,
  "---",
  "",
  "# Changelog",
  "",
  "Generated from the commit history by `npm run changelog`. **Do not hand-edit** —",
  "the next run overwrites it. To change an entry, the commit subject is the source.",
  "",
  "This project follows [Conventional Commits](https://www.conventionalcommits.org/)",
  "and [Semantic Versioning](https://semver.org/).",
  "",
  `## ${version}`,
  "",
];

const breaking = commits.filter((c) => c.breaking);
if (breaking.length) {
  lines.push("### Breaking changes", "");
  for (const c of breaking) lines.push(`- ${c.subject} (\`${c.sha.slice(0, 7)}\`)`);
  lines.push("");
}

for (const [type, heading] of SECTIONS) {
  const group = commits.filter((c) => c.type === type && !c.breaking);
  if (!group.length) continue;
  lines.push(`### ${heading}`, "");
  for (const c of group) {
    const scope = c.scope ? `**${c.scope}**: ` : "";
    lines.push(`- ${scope}${c.subject} (\`${c.sha.slice(0, 7)}\`)`);
  }
  lines.push("");
}

const other = commits.filter(
  (c) => !SECTIONS.some(([t]) => t === c.type) && !c.breaking,
);
if (other.length) {
  lines.push("### Other", "");
  for (const c of other) lines.push(`- ${c.subject} (\`${c.sha.slice(0, 7)}\`)`);
  lines.push("");
}

await writeFile(new URL("../CHANGELOG.md", import.meta.url), lines.join("\n"));
console.log(`CHANGELOG.md — ${commits.length} commits, released as "${version}".`);
