/**
 * Which settings the web UI may change, and what a valid value looks like.
 *
 * ── Why this is an allowlist and not a form over the file ───────────────────
 * The UI can write `.env`. That file configures a service holding a live
 * WhatsApp account, so "edit any variable" is not a feature — it is a way for
 * anyone holding the UI password to point the transcription endpoint at a
 * server they control, or to hand themselves the bridge token. Only the keys
 * below are writable, and every one of them is a FEATURE switch: what the agent
 * may do, who it may talk to, how long it keeps things, which third parties it
 * talks to.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 * Every credential that authenticates this UI or the services behind it —
 * `WA_UI_PASSWORD`, `WA_BRIDGE_TOKEN`, `WA_TRANSPORT_TOKEN`,
 * `WA_CONSOLE_PUSH_TOKEN` — and the model provider keys. Those are set once,
 * with shell access, by somebody who can read the file. A UI that can rotate
 * the secret that guards it is a UI that can lock its owner out or quietly
 * keep a copy; a UI that can rewrite the bridge token can point the agent at a
 * bridge that is not this one. `test/ui-settings.test.ts` asserts their absence
 * rather than trusting this comment.
 *
 * ── Third-party keys ARE editable, on purpose ───────────────────────────────
 * `BRAVE_API_KEY`, `ELEVENLABS_API_KEY` and `WA_TRANSCRIBE_KEY` only ever
 * ENABLE a feature that is otherwise absent. Getting one wrong costs a tool
 * that says it is not configured — the working state this system already has
 * for each of them — not access to anything.
 */

import { MODELS } from "./model.ts";
import { setEnvValues } from "./env-file.ts";

export type SettingKind =
  | "boolean"
  | "allowlist"
  | "list"
  | "days"
  | "millis"
  | "count"
  | "text"
  | "url"
  | "secret"
  | "choice";

export type RestartScope = "agent" | "bridge" | "none";

export interface SettingSpec {
  readonly key: string;
  readonly label: string;
  readonly kind: SettingKind;
  readonly section: string;
  /** Which service reads this at boot, and so must restart before it applies. */
  readonly restarts: RestartScope;
  /**
   * What the value MEANS — the consequence, not the syntax.
   *
   * Never optional. Every one of these switches has a cost that is invisible
   * from its name: an empty allowlist permits nobody, an unset retention window
   * keeps correspondence for ever, a transcription URL uploads other people's
   * voices. A row without that sentence is a row somebody will set wrongly.
   */
  readonly note: string;
  readonly choices?: readonly string[];
  /** What an empty value does, when empty is a real and different state. */
  readonly whenEmpty?: string;
  /**
   * What is in force when the file says nothing.
   *
   * Not decoration. `WA_ALLOW_SELF_NOTE` unset means TRUE — compose supplies
   * `:-true` — so a page that renders an unset boolean as `false` is showing
   * the opposite of what is running, and one Save away from switching self
   * notes off on the operator's behalf. Every key with a default declares it.
   */
  readonly defaultValue?: string;
}

export const SETTINGS: readonly SettingSpec[] = [
  {
    key: "WA_ALLOW_SEND",
    label: "Send to other people",
    kind: "boolean",
    section: "Sending",
    restarts: "bridge",
    note:
      "Off, no message reaches anyone but you. On, the allowlist below is the " +
      "only boundary — sends happen in one call, with no confirmation step.",
    defaultValue: "false",
  },
  {
    key: "WA_SEND_ALLOWLIST",
    label: "Allowlist",
    // Deliberately NOT a comma-separated list. The bridge's own splitter treats
    // a double-quoted entry as one name so that a group called "Ana, Bia, Cauê"
    // survives — and a naive split on every comma shatters it into three
    // entries, none of which match that group while each becomes its own
    // standing permission. Widening the send boundary by reformatting it is not
    // a rendering bug, so the raw value is carried through untouched.
    kind: "allowlist",
    section: "Sending",
    restarts: "bridge",
    note:
      "Matched case-insensitively, as a substring, against the name WhatsApp " +
      "resolves — so \"Ana\" also reaches \"Ana Paula\". Wrap an entry in " +
      "double quotes to keep the commas inside it: '\"Ana, Bia, Cauê\",We'.",
    whenEmpty: "An empty list permits NO ONE. It never means everyone.",
  },
  {
    key: "WA_ALLOW_SELF_NOTE",
    label: "Notes to your own chat",
    kind: "boolean",
    section: "Your own chat",
    restarts: "bridge",
    note:
      "The self chat is addressed from the transport's own device store, so " +
      "there is no name to resolve and no recipient to get wrong.",
    defaultValue: "true",
  },
  {
    key: "WA_CONSOLE_IDLE_MS",
    label: "Conversation goes cold after",
    kind: "millis",
    section: "Your own chat",
    restarts: "agent",
    note:
      "Silence after which the next message in /eve starts a new conversation " +
      "rather than continuing the old one.",
    whenEmpty: "Unset uses the built-in 45 minutes.",
  },
  {
    key: "WA_CONSOLE_MAX_TURNS",
    label: "…or after this many turns",
    kind: "count",
    section: "Your own chat",
    restarts: "agent",
    note:
      "A session that never ends eventually exceeds the model's window and the " +
      "turn is rejected outright.",
    whenEmpty: "Unset derives it from the model's window — half of it, capped at 60.",
  },
  {
    key: "WA_RETAIN_MESSAGE_DAYS",
    label: "Keep messages for",
    kind: "days",
    section: "Retention",
    restarts: "bridge",
    note:
      "Pruning cascades: removing a message removes the facts, transcripts, " +
      "extractions and arcs that cited it. Nothing runs on a timer.",
    whenEmpty: "Unset keeps correspondence for ever.",
  },
  {
    key: "WA_RETAIN_TRANSCRIPT_DAYS",
    label: "Keep transcripts for",
    kind: "days",
    section: "Retention",
    restarts: "bridge",
    note: "A transcript is a verbatim copy of somebody's voice, so it usually goes sooner.",
    whenEmpty: "Unset keeps them for ever.",
  },
  {
    key: "WA_RETAIN_RETRACTED_FACT_DAYS",
    label: "Keep retracted facts for",
    kind: "days",
    section: "Retention",
    restarts: "bridge",
    note:
      "A retraction is a tombstone, not a delete: \"why did I believe that?\" is " +
      "asked after the belief turns out to be wrong.",
    whenEmpty: "Unset keeps them for ever.",
  },
  {
    key: "WA_TRANSCRIBE_URL",
    label: "Voice notes → text",
    kind: "url",
    section: "What leaves this machine",
    restarts: "agent",
    note:
      "An OpenAI-compatible /audio/transcriptions endpoint. Pointing this at a " +
      "third party uploads voice notes from people who did not agree to it; " +
      "point it at a local whisper and nothing leaves.",
    whenEmpty: "Unset leaves voice notes listed but unread — a working state.",
  },
  {
    key: "WA_TRANSCRIBE_MODEL",
    label: "Transcription model",
    kind: "text",
    section: "What leaves this machine",
    restarts: "agent",
    note: "Whatever the endpoint above calls its model.",
    defaultValue: "gpt-transcribe",
  },
  {
    key: "WA_TRANSCRIBE_KEY",
    label: "Transcription key",
    kind: "secret",
    section: "What leaves this machine",
    restarts: "agent",
    note:
      "Only needed for a non-local endpoint. A remote URL with no key is " +
      "refused before the audio is downloaded, rather than after.",
  },
  {
    key: "BRAVE_API_KEY",
    label: "Web search key",
    kind: "secret",
    section: "What leaves this machine",
    restarts: "agent",
    note: "Only the query is uploaded — never a message, a contact or a chat.",
    whenEmpty: "Unset, the search tool says it is not configured.",
  },
  {
    key: "WA_SEARCH_COUNTRY",
    label: "Search country",
    kind: "text",
    section: "What leaves this machine",
    restarts: "agent",
    note: "Two-letter code Brave biases results towards.",
  },
  {
    key: "WA_SEARCH_LANG",
    label: "Search language",
    kind: "text",
    section: "What leaves this machine",
    restarts: "agent",
    note: "Language tag Brave biases results towards.",
  },
  {
    key: "WA_IMAGE_MODEL",
    label: "Image model",
    kind: "text",
    section: "What leaves this machine",
    restarts: "agent",
    note: "Only the prompt is uploaded — no message, no contact, no image from a chat.",
    defaultValue: "gpt-image-1",
  },
  {
    key: "WA_IMAGE_QUALITY",
    label: "Image quality",
    kind: "choice",
    section: "What leaves this machine",
    restarts: "agent",
    choices: ["low", "medium", "high"],
    note: "Higher quality costs more and takes longer; it does not make the model spell.",
    defaultValue: "medium",
  },
  {
    key: "ELEVENLABS_API_KEY",
    label: "Spoken replies key",
    kind: "secret",
    section: "What leaves this machine",
    restarts: "agent",
    note: "Sends the text to be spoken. Unset, voice replies are simply unavailable.",
  },
  {
    key: "WA_ELEVENLABS_VOICE_ID",
    label: "Voice id",
    kind: "text",
    section: "What leaves this machine",
    restarts: "agent",
    note: "Which voice speaks. A voice that sounds like a real person is not a costume.",
  },
  {
    key: "WA_CALENDAR_ICS_URL",
    label: "Calendar feed",
    kind: "url",
    section: "What leaves this machine",
    restarts: "agent",
    note: "A read-only ICS URL. Nothing is written back to it.",
    whenEmpty: "Unset, the calendar tool is unavailable.",
  },
  {
    key: "WA_MODEL_ID",
    label: "Model",
    kind: "choice",
    section: "Model",
    restarts: "agent",
    choices: Object.keys(MODELS),
    note:
      "Only models in the registry are offered: every guard here is a fraction " +
      "of the model's context window, and an unmeasured model leaves those " +
      "guards sized for a different one.",
    whenEmpty: "Unset uses the registry's default.",
  },
  {
    key: "WA_TRANSPORT_DRAIN_INTERVAL_MS",
    label: "Drain the outbox every",
    kind: "millis",
    section: "Reception",
    restarts: "bridge",
    note:
      "How often the bridge pulls what the transport has received. Draining " +
      "costs nothing WhatsApp can see; it is not an interaction with the phone.",
    whenEmpty: "Unset drains every 5 seconds.",
    defaultValue: "5000",
  },
];

const BY_KEY = new Map(SETTINGS.map((spec) => [spec.key, spec]));

export function settingSpec(key: string): SettingSpec | undefined {
  return BY_KEY.get(key);
}

export type Validation = { ok: true; value: string } | { ok: false; error: string };

/**
 * One value, checked against what its kind actually permits.
 *
 * Empty is accepted for every kind except `boolean` and `choice`, because
 * "unset" is a real and documented state for the rest of them — and each spec
 * says what unset does rather than leaving the operator to find out.
 */
export function validateSetting(spec: SettingSpec, raw: string): Validation {
  const value = String(raw ?? "").trim();

  if (/[\r\n]/.test(value)) {
    return { ok: false, error: "a value may not contain a line break" };
  }

  switch (spec.kind) {
    case "boolean":
      if (value !== "true" && value !== "false") {
        return { ok: false, error: "must be true or false" };
      }
      return { ok: true, value };

    case "choice":
      if (value === "" && spec.whenEmpty) return { ok: true, value };
      if (!spec.choices?.includes(value)) {
        return { ok: false, error: `must be one of ${spec.choices?.join(", ")}` };
      }
      return { ok: true, value };

    case "allowlist": {
      if (value === "") return { ok: true, value };
      // Balanced quotes only: an unclosed one silently swallows the rest of the
      // list into a single entry, which is a permission nobody granted.
      const doubles = (value.match(/"/g) ?? []).length;
      if (doubles % 2 !== 0) {
        return { ok: false, error: "there is an unclosed double quote in that list" };
      }
      if (value.includes("'")) {
        return {
          ok: false,
          error: "use double quotes around an entry containing a comma, not single quotes",
        };
      }
      return { ok: true, value };
    }

    case "list": {
      if (value === "") return { ok: true, value };
      const items = value.split(",").map((item) => item.trim());
      if (items.some((item) => item === "")) {
        return { ok: false, error: "an empty entry would match nobody — remove the stray comma" };
      }
      return { ok: true, value: items.join(",") };
    }

    case "days":
    case "millis":
    case "count": {
      if (value === "") return { ok: true, value };
      if (!/^\d+$/.test(value)) {
        // A negative or unparseable retention window means "keep for ever" to
        // the bridge, deliberately, so a typo cannot delete an archive. That is
        // the right file semantics and the wrong FORM semantics: someone typing
        // "-1" into a box labelled "keep for" means a number, not for ever.
        return { ok: false, error: "must be a whole number of days or blank for for ever" };
      }
      return { ok: true, value };
    }

    case "url": {
      if (value === "") return { ok: true, value };
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return { ok: false, error: "must be a full URL, including http:// or https://" };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: "must be an http or https URL" };
      }
      return { ok: true, value };
    }

    case "secret":
    case "text":
      return { ok: true, value };
  }
}

export class SettingRefused extends Error {}

/**
 * Apply a batch of changes to the file's text, or refuse the whole batch.
 *
 * All or nothing: a form that half-applied would leave the operator reading a
 * page where some rows took and some did not, with no way to tell which. The
 * dangerous version of that is a save that sets the allowlist and then fails to
 * set the switch that was meant to keep it closed.
 */
export function applySettings(fileText: string, updates: Record<string, string>): string {
  const checked: Record<string, string> = {};

  for (const [key, raw] of Object.entries(updates)) {
    const spec = BY_KEY.get(key);
    if (!spec) {
      throw new SettingRefused(
        `${key} is not editable from the web UI. Credentials and service tokens are ` +
          `changed in the file, by someone with access to the host.`,
      );
    }
    const result = validateSetting(spec, raw);
    if (!result.ok) throw new SettingRefused(`${key}: ${result.error}`);
    checked[key] = result.value;
  }

  return setEnvValues(fileText, checked);
}

/**
 * What a secret looks like once it has been set: its shape, never its value.
 *
 * The UI has to say whether a key is present — a blank box is indistinguishable
 * from "no key configured" — without becoming a way to read the key back out of
 * a file the browser cannot otherwise see.
 */
export function maskSecret(value: string): string {
  if (!value) return "";
  return `set · ${value.length} characters`;
}
