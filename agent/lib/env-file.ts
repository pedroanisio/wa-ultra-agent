/**
 * Reading and rewriting `.env` in place.
 *
 * ── Why a file and not a settings table ─────────────────────────────────────
 * Every switch in this system is already an environment variable, read at boot
 * by whichever service owns it. A settings row in `store.db` would be a SECOND
 * source of truth for the same question — and the two would disagree the first
 * time somebody edited the file by hand, which is still the documented way to
 * configure this stack. So the UI edits the same file the README tells you to
 * edit, and the running process keeps reading its own environment.
 *
 * The consequence is honest rather than hidden: a write here changes what the
 * NEXT start will see, never what the current process is doing. `ui-model.ts`
 * renders that as effective-versus-pending rather than pretending a toggle took
 * effect.
 *
 * ── Why the rewrite is surgical ─────────────────────────────────────────────
 * `.env.example` is 300 lines of commentary explaining what each variable costs
 * you — which uploads private audio to a third party, which one permits nobody
 * when empty. A writer that serialised a parsed map back out would delete all
 * of it on the first save, and the operator would be left with a file of bare
 * assignments and no reason for any of them. So the file is edited as TEXT: the
 * line for a key is replaced, everything else survives byte for byte.
 */

/** The filesystem calls the writer needs, injected so both paths are testable. */
export interface EnvFs {
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/**
 * Replace the file's contents without leaving a half-written one behind.
 *
 * ── Why this is not simply a rename ─────────────────────────────────────────
 * Writing a sibling and renaming over the target is the standard way to make a
 * replacement atomic, and it is what this does first. It also fails outright in
 * the deployment this feature exists for: `docker-compose.yml` bind-mounts
 * `./.env` as a SINGLE FILE, and a bind-mounted file is a mount point. Renaming
 * over a mount point returns EBUSY, so on Docker the tidy path fails every
 * time — and a Preferences screen whose every save fails is worse than one that
 * is honestly read-only.
 *
 * So a failed rename falls back to writing in place. That window is genuinely
 * less safe: a crash inside it leaves a truncated `.env`, which is a bridge
 * with no token rather than a lost preference. It is accepted because the
 * alternative is not "safer", it is "the feature does not work", and because
 * the file is small enough that a single `writeFile` is one operation on every
 * filesystem this runs on.
 *
 * The temporary file is always cleaned up: leaving `.env.1234.tmp` next to
 * `.env` in a directory operators read is its own small confusion.
 */
export async function writeEnvFileSafely(
  path: string,
  text: string,
  temporaryPath: string,
  fs: EnvFs,
): Promise<"renamed" | "in-place"> {
  try {
    await fs.writeFile(temporaryPath, text, "utf8");
    await fs.rename(temporaryPath, path);
    return "renamed";
  } catch {
    // Best effort: the temporary file may not exist, and failing to remove it
    // must not mask the write that matters.
    await fs.unlink(temporaryPath).catch(() => {});
    await fs.writeFile(path, text, "utf8");
    return "in-place";
  }
}

/** One assignment, as it appears in the file. */
export interface EnvEntry {
  readonly key: string;
  readonly value: string;
  /** Zero-based index of the line it was found on, for surgical replacement. */
  readonly line: number;
}

/**
 * `KEY=value`, with optional `export`, optional surrounding whitespace.
 *
 * Anchored and deliberately narrow: anything that does not match is a comment,
 * a blank line, or something this parser does not understand — and all three
 * are preserved untouched rather than guessed at.
 */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * Strip one layer of matching quotes, the way a shell would.
 *
 * A double-quoted value is also UNESCAPED, because `formatEnvValue` escapes on
 * the way out. Without the inverse here, a name containing a quote came back
 * from a round trip with backslashes in it that nobody typed — and since the
 * allowlist is matched as a substring against a display name, a mangled entry
 * silently stops matching the person it was meant to permit.
 */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === '"' && last === '"') {
      return value.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
    }
    // Single quotes are literal in a shell: nothing inside them is escaped.
    if (first === "'" && last === "'") return value.slice(1, -1);
  }
  // An unquoted value ends at a comment, which is how `.env.example` annotates
  // defaults inline. Quoted values keep their `#`, because it was quoted.
  const hash = value.indexOf(" #");
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

/** Every assignment in the file, last occurrence winning, as a shell would. */
export function parseEnvFile(text: string): Map<string, EnvEntry> {
  const entries = new Map<string, EnvEntry>();
  text.split("\n").forEach((line, index) => {
    const match = ASSIGNMENT.exec(line);
    if (!match) return;
    entries.set(match[1], { key: match[1], value: unquote(match[2]), line: index });
  });
  return entries;
}

/** The plain `key → value` view, for comparing against `process.env`. */
export function envValues(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, entry] of parseEnvFile(text)) values[key] = entry.value;
  return values;
}

/**
 * A value that cannot become a second assignment.
 *
 * ── The attack this closes ──────────────────────────────────────────────────
 * The UI writes this file, and the file is the configuration of a service that
 * holds a live WhatsApp account. A value containing a newline would end the
 * line it was written on and start a new one, so a send allowlist submitted as
 *
 *     Mum\nWA_ALLOW_SEND=true
 *
 * would set a variable nobody asked to set. Refusing the character is the only
 * defence that does not depend on every future caller remembering to escape it,
 * and no legitimate value here spans lines.
 */
export class EnvValueError extends Error {}

export function formatEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new EnvValueError("a value may not contain a line break");
  }
  if (value === "") return "";

  // ── Why a double-quoted value may need single quotes ──────────────────────
  // The send allowlist legitimately contains double quotes, and they are
  // SIGNIFICANT: the bridge's splitter uses them to protect the commas inside a
  // group name like "Ana, Bia, Cauê". Escaping them into `\"` hands a different
  // literal to whatever reads the file next — Compose, dotenv and a shell do
  // not agree on backslash escapes inside double quotes. Single quotes are
  // literal in all three, so a value carrying double quotes is wrapped in them
  // instead, which is exactly how such a list is written by hand.
  if (value.includes('"') && !value.includes("'")) return `'${value}'`;

  // A value carrying both kinds cannot be quoted safely in either, and
  // guessing produces a silently different value in a file that decides who
  // may be messaged.
  if (value.includes('"') && value.includes("'")) {
    throw new EnvValueError(
      "a value may not contain both single and double quotes — there is no quoting that " +
        "survives every reader of this file",
    );
  }

  // Otherwise quote whenever the shell would re-interpret it. `#` matters most:
  // an unquoted one turns the rest of the value into a comment.
  if (/[\s'#$`\\]/.test(value)) return `"${value.replace(/([\\$`])/g, "\\$1")}"`;
  return value;
}

/**
 * The file, with these keys set — comments, order and unrelated lines intact.
 *
 * A key that is already present is replaced ON ITS OWN LINE, so the commentary
 * above it still describes the value below it. A key that is absent is appended
 * under a header saying who wrote it, because a variable that appears in a file
 * with no explanation is the thing this project's `.env.example` exists to
 * prevent.
 */
export function setEnvValues(text: string, updates: Record<string, string>): string {
  const keys = Object.keys(updates);
  if (keys.length === 0) return text;

  const entries = parseEnvFile(text);
  const lines = text.split("\n");
  const appended: string[] = [];

  for (const key of keys) {
    const formatted = formatEnvValue(updates[key]);
    const existing = entries.get(key);
    if (existing) {
      lines[existing.line] = `${key}=${formatted}`;
    } else {
      appended.push(`${key}=${formatted}`);
    }
  }

  if (appended.length === 0) return lines.join("\n");

  const header = ["", "# ── Set from the web UI ─────────────────────────────────────────────────────"];
  const trailingBlank = lines.length > 0 && lines[lines.length - 1] === "";
  const body = trailingBlank ? lines.slice(0, -1) : lines;
  return [...body, ...header, ...appended, ""].join("\n");
}
