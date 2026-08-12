/**
 * Saying what period the archive covers, in words.
 *
 * The agent was asked "what period are you considering?" and could only answer
 * with a count — 8,824 messages, 203 conversations — because a count was all it
 * had. Then it was asked for the oldest date and had to say it could not see
 * one. Both answers were true and both were useless, and the fix is not a
 * cleverer prompt: the number simply was not in the tool surface.
 *
 * This turns the bridge's `span` into the sentence the model should repeat. It
 * lives apart from the tool so the wording — especially the wording of the
 * cases where the span is NOT the whole truth — is testable.
 */

import type { ArchiveSpan } from "./bridge.ts";

/** `2026-08-11T23:14:02Z` → `11 Aug 2026`. Dates a person reads on a phone. */
export function formatDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso.slice(0, 10);
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * One clause describing the covered period, for a sentence about the archive.
 *
 * Three cases, and the third is the one that matters. An archive whose oldest
 * rows lost their timestamps can still report bounds — from the rows that kept
 * theirs — and quoting those bounds alone turns "I can see back to 3 June" into
 * a claim the archive cannot support. So undated rows are counted out loud.
 */
export function describeSpan(span: ArchiveSpan | null | undefined): string {
  if (!span || !span.oldest || !span.newest) {
    return "with no dated messages, so there is no period to report.";
  }

  const period = `covering ${formatDay(span.oldest)} to ${formatDay(span.newest)} (${span.days} day${
    span.days === 1 ? "" : "s"
  }).`;

  if (span.undated > 0) {
    return (
      `${period} ${span.undated} message${span.undated === 1 ? "" : "s"} carry no usable timestamp and ` +
      "fall outside that period — say so rather than presenting the range as the whole archive."
    );
  }

  return period;
}

/**
 * The clause a dated query should carry when it reports a result.
 *
 * A window the archive cannot cover is the failure mode here: "check the last
 * 45 days" against an archive that reaches back nine is answerable, and the
 * answer is "nine days is all there is", not an empty list.
 */
export function describeWindow(
  span: ArchiveSpan | null | undefined,
  since: string | undefined,
): string | undefined {
  if (!since || !span?.oldest) return undefined;

  const asked = new Date(since);
  const oldest = new Date(span.oldest);
  if (Number.isNaN(asked.getTime()) || Number.isNaN(oldest.getTime())) return undefined;
  if (asked >= oldest) return undefined;

  return (
    `The window asked for starts ${formatDay(since)}, but the archive only reaches back to ` +
    `${formatDay(span.oldest)} — anything earlier has not been read, so an empty result there means ` +
    "unread, not nothing."
  );
}
