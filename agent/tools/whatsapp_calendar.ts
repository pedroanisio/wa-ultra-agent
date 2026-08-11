import { defineTool } from "eve/tools";
import { z } from "zod";

import { agendaFor, conflictsWith, parseIcs } from "../lib/calendar.ts";

/**
 * Read the user's calendar.
 *
 * Via a secret .ics URL rather than the Google Calendar API: no OAuth app to
 * register, no consent screen, no token to refresh, and nothing to rotate. It is
 * read-only, which is the right first shape — reading a schedule is what makes
 * "your dentist clashes with the 14:00" possible, and writing to someone's
 * calendar unattended is a Level 2 action nobody asked for.
 *
 * Unset means the capability is simply absent, and says so.
 */

const MAX_BYTES = 5 * 1024 * 1024;

export default defineTool({
  description:
    "Read the user's calendar for a day, or check whether a time is free. Use it before agreeing to " +
    "a time on their behalf, when a message proposes a meeting, or when they ask what their day " +
    "looks like. Pass `date` for the agenda; add `start`/`end` to test a specific window for " +
    "clashes. Read-only: it cannot create or change events. If it reports that no calendar is " +
    "configured, tell the user and do not guess at their availability.",
  inputSchema: z.object({
    date: z.string().describe("ISO date, e.g. 2026-08-12."),
    start: z.string().optional().describe("ISO instant. With `end`, checks that window for clashes."),
    end: z.string().optional().describe("ISO instant."),
  }),
  async execute({ date, start, end }, ctx) {
    const url = (process.env.WA_CALENDAR_ICS_URL || "").trim();
    if (!url) {
      return {
        ok: false as const,
        configured: false,
        error:
          "No calendar is configured. Set WA_CALENDAR_ICS_URL to the secret .ics address from " +
          "Google Calendar (Settings → your calendar → Secret address in iCal format), Apple or " +
          "Outlook. That URL is a credential: anyone holding it can read the whole calendar.",
      };
    }

    let text: string;
    try {
      const response = await fetch(url, { signal: ctx.abortSignal });
      if (!response.ok) {
        return {
          ok: false as const,
          configured: true,
          error: `The calendar feed returned HTTP ${response.status}. The secret address may have been reset.`,
        };
      }
      const body = await response.text();
      if (body.length > MAX_BYTES) {
        return { ok: false as const, configured: true, error: "The calendar feed is too large to read." };
      }
      text = body;
    } catch (error) {
      return { ok: false as const, configured: true, error: `Could not fetch the calendar: ${(error as Error).message}` };
    }

    const events = parseIcs(text);
    const agenda = agendaFor(events, date);
    const clashes = start ? conflictsWith(events, { start, end: end || start }) : [];

    return {
      ok: true as const,
      configured: true,
      date,
      agenda,
      clashes,
      checkedWindow: start ? { start, end: end || start } : undefined,
      // A floating event's wall-clock time is known but its instant is not.
      floatingCount: agenda.filter((e) => e.floating).length,
    };
  },

  toModelOutput(output) {
    if (!output.ok) {
      return {
        type: "text" as const,
        value: output.configured
          ? `Calendar unavailable: ${output.error}`
          : `${output.error}\n\nSay this to the user; do not guess whether they are free.`,
      };
    }

    const line = (e: (typeof output.agenda)[number]) =>
      e.allDay
        ? `- all day: ${e.summary}`
        : `- ${e.start.slice(11, 16)}–${e.end.slice(11, 16)}${e.floating ? " (local time)" : ""}: ${e.summary}`;

    const parts = [
      output.agenda.length
        ? `${output.date}:\n${output.agenda.map(line).join("\n")}`
        : `Nothing scheduled on ${output.date}.`,
    ];

    if (output.checkedWindow) {
      parts.push(
        output.clashes.length
          ? `CLASH: that window overlaps ${output.clashes.map((e) => `"${e.summary}"`).join(", ")}.`
          : "That window is free.",
      );
    }

    if (output.floatingCount > 0) {
      parts.push(
        `${output.floatingCount} event(s) carry a timezone this cannot resolve — their times are ` +
          "wall-clock local, so say the time as written rather than converting it.",
      );
    }

    return { type: "text" as const, value: parts.join("\n\n") };
  },
});
