/**
 * What the model can actually reach right now, and why the rest is dark.
 *
 * ── Why a tool going dark is a working state ────────────────────────────────
 * Every optional capability here fails the same way on purpose: no key means
 * the tool reports that it is not configured, rather than attempting the call
 * and failing somewhere the operator cannot see. That is deliberate design in
 * `search.ts`, `transcribe.ts` and `imagegen.ts` — and it is invisible from
 * outside, because a tool that is absent looks exactly like a tool the model
 * chose not to use. This module makes the difference legible.
 *
 * ── Why the table is hand-written ───────────────────────────────────────────
 * A tool's requirement is not a property the file declares; it lives in the
 * library the tool calls, as an early return with a sentence explaining what to
 * set. Deriving it would mean executing each tool. So the table is written
 * down — and `test/ui-tools.test.ts` asserts it covers exactly the files in
 * `agent/tools/`, so a tool added without a row here fails the suite rather
 * than quietly disappearing from the page.
 */

import { ELEVENLABS_KEY_NAMES } from "./speech.ts";

/**
 * What a call costs you — which is the useful way to group a tool surface.
 *
 * Not by module: a reader wants to know what happens if the model reaches for
 * this, and "it lands on somebody's phone" is a different answer from "it reads
 * a row that is already here".
 */
export type ToolGroup = "reading" | "writing" | "remembering" | "making";

export const GROUP_LABELS: Record<ToolGroup, string> = {
  reading: "Reading — free, and always on",
  writing: "Writing — each one is a real message on somebody's phone",
  remembering: "Remembering — every row must cite a message",
  making: "Making",
};

export type ToolState = "live" | "gated" | "dark";

export interface ToolSpec {
  /** The file stem in `agent/tools/`, which is also the tool's name. */
  readonly tool: string;
  readonly group: ToolGroup;
  /**
   * Environment keys, any ONE of which switches this tool on.
   *
   * Empty means the tool needs nothing beyond the bridge, which every tool
   * needs and which the Setup screen covers once rather than per row.
   */
  readonly needsAny?: readonly string[];
  /**
   * A switch that must be `true` for the call to be ACCEPTED, though the tool
   * itself is present either way. The distinction matters: a gated tool is one
   * the model will call and the bridge will refuse, which is a different thing
   * to explain than a tool that was never there.
   */
  readonly gatedBy?: string;
  /** What to say when it is dark. Never a bare variable name. */
  readonly whenDark?: string;
}

export const TOOLS: readonly ToolSpec[] = [
  // ── reading ────────────────────────────────────────────────────────
  { tool: "whatsapp_read_chat", group: "reading" },
  { tool: "whatsapp_list_chats", group: "reading" },
  { tool: "whatsapp_search_archive", group: "reading" },
  { tool: "whatsapp_get_context", group: "reading" },
  { tool: "whatsapp_archive_chat", group: "reading" },
  { tool: "whatsapp_status", group: "reading" },
  { tool: "whatsapp_person", group: "reading" },
  { tool: "whatsapp_twin", group: "reading" },
  { tool: "whatsapp_next_best", group: "reading" },
  { tool: "whatsapp_obligations", group: "reading" },
  { tool: "whatsapp_attention", group: "reading" },
  { tool: "whatsapp_view_media", group: "reading" },
  { tool: "whatsapp_resolve_contact", group: "reading" },
  { tool: "whatsapp_refresh_names", group: "reading" },
  { tool: "whatsapp_console_pending", group: "reading" },
  {
    tool: "whatsapp_calendar",
    group: "reading",
    needsAny: ["WA_CALENDAR_ICS_URL"],
    whenDark: "No calendar feed is configured, so there is nothing to read.",
  },
  {
    tool: "whatsapp_search_web",
    group: "reading",
    needsAny: ["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY"],
    whenDark: "No Brave key, so the web cannot be searched. Only the query would be uploaded.",
  },

  // ── writing ────────────────────────────────────────────────────────
  {
    tool: "whatsapp_send_message",
    group: "writing",
    gatedBy: "WA_ALLOW_SEND",
    whenDark: "Sending is off. The tool is present; the bridge refuses every call.",
  },
  { tool: "whatsapp_react", group: "writing", gatedBy: "WA_ALLOW_SEND" },
  { tool: "whatsapp_edit_message", group: "writing", gatedBy: "WA_ALLOW_SEND" },
  { tool: "whatsapp_revoke_message", group: "writing", gatedBy: "WA_ALLOW_SEND" },
  { tool: "whatsapp_poll", group: "writing", gatedBy: "WA_ALLOW_SEND" },
  { tool: "whatsapp_presence", group: "writing", gatedBy: "WA_ALLOW_SEND" },
  {
    tool: "whatsapp_write_self",
    group: "writing",
    gatedBy: "WA_ALLOW_SELF_NOTE",
    whenDark: "Notes to your own chat are switched off.",
  },
  {
    tool: "whatsapp_send_image",
    group: "writing",
    needsAny: ["OPENAI_API_KEY"],
    whenDark: "There is no image model configured, so there is nothing generated to send.",
  },
  {
    tool: "whatsapp_send_voice",
    group: "writing",
    needsAny: [...ELEVENLABS_KEY_NAMES, "OPENAI_API_KEY"],
    whenDark: "No speech provider is configured, so nothing can be spoken.",
  },
  { tool: "whatsapp_tictactoe", group: "writing", gatedBy: "WA_ALLOW_SELF_NOTE" },

  // ── remembering ────────────────────────────────────────────────────
  { tool: "whatsapp_remember_fact", group: "remembering" },
  { tool: "whatsapp_remember_alias", group: "remembering" },
  { tool: "whatsapp_retract_fact", group: "remembering" },
  { tool: "whatsapp_extract_actions", group: "remembering" },
  { tool: "whatsapp_resolve_obligation", group: "remembering" },
  { tool: "whatsapp_resolve_proposal", group: "remembering" },
  { tool: "whatsapp_model_interaction", group: "remembering" },

  // ── making ─────────────────────────────────────────────────────────
  {
    tool: "whatsapp_generate_image",
    group: "making",
    needsAny: ["OPENAI_API_KEY"],
    whenDark: "No image model is configured. Only a prompt would ever be uploaded.",
  },
  {
    tool: "whatsapp_deliver_render",
    group: "making",
    needsAny: ["WA_FRAMEFORGE_MCP_URL"],
    whenDark:
      "The document renderer is off. Start the stack with the frameforge profile, " +
      "or point WA_FRAMEFORGE_MCP_URL at one.",
  },
  {
    tool: "whatsapp_transcribe_voice",
    group: "making",
    needsAny: ["WA_TRANSCRIBE_URL"],
    whenDark:
      "No transcription endpoint, so voice notes stay listed but unread — a working state.",
  },
];

export interface ToolStatus extends ToolSpec {
  readonly state: ToolState;
  /** Why it is not live. Empty when it is. */
  readonly reason: string;
}

function isSet(env: Record<string, string | undefined>, key: string): boolean {
  return Boolean(env[key]?.trim());
}

function isTrue(env: Record<string, string | undefined>, key: string): boolean {
  return env[key]?.trim().toLowerCase() === "true";
}

/**
 * Each tool's state in this environment.
 *
 * `dark` beats `gated`: a tool with no key is absent whatever the send switch
 * says, and reporting the switch first would send somebody to the wrong screen.
 */
export function toolStatus(env: Record<string, string | undefined>): ToolStatus[] {
  return TOOLS.map((spec) => {
    if (spec.needsAny && !spec.needsAny.some((key) => isSet(env, key))) {
      return {
        ...spec,
        state: "dark" as const,
        reason: spec.whenDark ?? `Needs one of: ${spec.needsAny.join(", ")}.`,
      };
    }
    if (spec.gatedBy && !isTrue(env, spec.gatedBy)) {
      return {
        ...spec,
        state: "gated" as const,
        reason: spec.whenDark ?? `${spec.gatedBy} is not true, so a call is refused.`,
      };
    }
    return { ...spec, state: "live" as const, reason: "" };
  });
}

/** The counts the page's header states, computed once rather than in markup. */
export function toolTally(statuses: readonly ToolStatus[]): {
  total: number;
  live: number;
  gated: number;
  dark: number;
} {
  return {
    total: statuses.length,
    live: statuses.filter((s) => s.state === "live").length,
    gated: statuses.filter((s) => s.state === "gated").length,
    dark: statuses.filter((s) => s.state === "dark").length,
  };
}
