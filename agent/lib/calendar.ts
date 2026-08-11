/**
 * The calendar, without OAuth.
 *
 * The draft called calendar "probably your highest-value external tool", and it
 * is — but the obvious route to it, the Google Calendar API, needs an OAuth app
 * registered, a consent screen, and token refresh. That is a project, not an
 * integration.
 *
 * Every major calendar also publishes a **secret .ics URL**: Google, Apple,
 * Outlook and Fastmail all offer one. The user pastes one address and it works,
 * with no application to register and no credential to rotate. It is read-only,
 * which is exactly the right shape for a first calendar integration — reading a
 * schedule is what makes "your dentist clashes with the 14:00" possible, and
 * writing to someone's calendar unattended is a Level 2 action nobody asked for.
 *
 * ── The known limit ─────────────────────────────────────────────────────────
 * `DTSTART;TZID=America/Sao_Paulo:20260810T140000` needs a timezone database to
 * resolve to an instant. Rather than guess an offset — which would silently
 * shift every appointment — those are parsed as floating local time and marked
 * `floating: true`, so a caller can say "14:00 local" instead of asserting a
 * moment it cannot actually know.
 */

export interface CalendarEvent {
  uid: string;
  summary: string;
  /** ISO instant. For floating events, the wall-clock time read as UTC. */
  start: string;
  end: string;
  allDay: boolean;
  /** True when the source carried a TZID this cannot resolve. Treat as local. */
  floating: boolean;
  location?: string;
}

/** ICS folds long lines by starting continuations with a space or tab. */
function unfold(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function unescape(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** `20260810T140000Z`, `20260810T140000`, or `20260810` → ISO, or null. */
function parseIcsDate(raw: string): { iso: string; dateOnly: boolean } | null {
  const value = raw.trim();

  const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return { iso: `${y}-${m}-${d}T00:00:00.000Z`, dateOnly: true };
  }

  const stamp = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!stamp) return null;

  const [, y, m, d, hh, mm, ss] = stamp;
  const parsed = new Date(Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss));
  return Number.isNaN(parsed.getTime()) ? null : { iso: parsed.toISOString(), dateOnly: false };
}

/** Events from an .ics document. Anything unparseable is skipped, never guessed. */
export function parseIcs(text: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  let current: Record<string, { value: string; params: string }> | null = null;
  // VALARM lives inside VEVENT and has its own DTSTART; ignore that block.
  let depth = 0;

  for (const line of unfold(text || "")) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      depth = 0;
      continue;
    }
    if (current && line.startsWith("BEGIN:")) {
      depth++;
      continue;
    }
    if (current && depth > 0) {
      if (line.startsWith("END:")) depth--;
      continue;
    }

    if (line === "END:VEVENT") {
      if (current) {
        const start = current.DTSTART ? parseIcsDate(current.DTSTART.value) : null;
        // No usable start means no usable event. Skipping is honest; inventing
        // a time would put a phantom appointment in someone's day.
        if (start) {
          const end = current.DTEND ? parseIcsDate(current.DTEND.value) : null;
          const hasTzid = /TZID=/i.test(current.DTSTART?.params || "");

          events.push({
            uid: current.UID?.value || "",
            summary: unescape(current.SUMMARY?.value || "(untitled)"),
            start: start.iso,
            end: end?.iso ?? start.iso,
            allDay: start.dateOnly,
            floating: hasTzid,
            location: current.LOCATION ? unescape(current.LOCATION.value) : undefined,
          });
        }
      }
      current = null;
      continue;
    }

    if (!current) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const rawName = line.slice(0, separator);
    const [name, ...params] = rawName.split(";");
    current[name.toUpperCase()] = { value: line.slice(separator + 1), params: params.join(";") };
  }

  return events;
}

function dayBounds(date: string): { start: number; end: number } {
  const start = Date.parse(`${date}T00:00:00.000Z`);
  return { start, end: start + 86_400_000 };
}

/**
 * Which events overlap a window.
 *
 * Half-open: an event ending exactly when the window starts is not a clash, or
 * every back-to-back meeting would report one. Pass `date` instead of
 * start/end to check a whole day.
 */
export function conflictsWith(
  events: CalendarEvent[],
  window: { start?: string; end?: string; date?: string },
): CalendarEvent[] {
  const bounds = window.date
    ? dayBounds(window.date)
    : { start: Date.parse(window.start || ""), end: Date.parse(window.end || window.start || "") };

  if (Number.isNaN(bounds.start)) return [];

  return events.filter((event) => {
    const eventStart = Date.parse(event.start);
    // An all-day event covers its day even when DTEND is missing.
    const eventEnd = event.allDay
      ? Math.max(Date.parse(event.end), eventStart + 86_400_000)
      : Date.parse(event.end);

    return eventStart < bounds.end && eventEnd > bounds.start;
  });
}

/** Everything on one day, chronological. */
export function agendaFor(events: CalendarEvent[], date: string): CalendarEvent[] {
  return conflictsWith(events, { date }).sort((a, b) => a.start.localeCompare(b.start));
}
