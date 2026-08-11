import { test } from "node:test";
import assert from "node:assert/strict";

import { agendaFor, conflictsWith, parseIcs } from "../agent/lib/calendar.ts";

/**
 * Calendar without OAuth.
 *
 * Google, Apple and Outlook all publish a calendar as a secret .ics URL, which
 * needs no OAuth app, no consent screen and no token refresh — the user pastes
 * one address and it works. That keeps the highest-value external integration
 * (the draft's words) reachable without asking anyone to register an
 * application, and the parsing is pure, so all of it is testable here.
 *
 * The known limit is timezones: a `TZID` reference needs a tz database to
 * resolve, so those are treated as floating local time and flagged, rather than
 * silently shifted by a guess.
 */

const ics = (body: string) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", body, "END:VCALENDAR"].join("\r\n");

const event = (over: Record<string, string> = {}) =>
  ics(
    [
      "BEGIN:VEVENT",
      "UID:abc-123",
      "SUMMARY:Reunião de projeto",
      "DTSTART:20260810T140000Z",
      "DTEND:20260810T150000Z",
      ...Object.entries(over).map(([k, v]) => `${k}:${v}`),
      "END:VEVENT",
    ].join("\r\n"),
  );

/* ---------------------------------------------------------------- *
 * Parsing
 * ---------------------------------------------------------------- */

test("parses one event", () => {
  const [e] = parseIcs(event());

  assert.equal(e.uid, "abc-123");
  assert.equal(e.summary, "Reunião de projeto");
  assert.equal(e.start, "2026-08-10T14:00:00.000Z");
  assert.equal(e.end, "2026-08-10T15:00:00.000Z");
  assert.equal(e.allDay, false);
});

test("parses several events", () => {
  const text = ics(
    [
      "BEGIN:VEVENT\r\nUID:1\r\nSUMMARY:One\r\nDTSTART:20260810T090000Z\r\nDTEND:20260810T100000Z\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:2\r\nSUMMARY:Two\r\nDTSTART:20260810T110000Z\r\nDTEND:20260810T120000Z\r\nEND:VEVENT",
    ].join("\r\n"),
  );
  assert.equal(parseIcs(text).length, 2);
});

test("reads an all-day event as covering the whole day", () => {
  const text = ics(
    "BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Feriado\r\nDTSTART;VALUE=DATE:20260810\r\nDTEND;VALUE=DATE:20260811\r\nEND:VEVENT",
  );
  const [e] = parseIcs(text);

  assert.equal(e.allDay, true);
  assert.equal(e.start, "2026-08-10T00:00:00.000Z");
});

test("unfolds continuation lines, which is how long summaries arrive", () => {
  const text = ics(
    "BEGIN:VEVENT\r\nUID:f\r\nSUMMARY:Uma reunião muito\r\n  longa mesmo\r\nDTSTART:20260810T140000Z\r\nDTEND:20260810T150000Z\r\nEND:VEVENT",
  );
  assert.equal(parseIcs(text)[0].summary, "Uma reunião muito longa mesmo");
});

test("unescapes commas, semicolons and newlines", () => {
  const [e] = parseIcs(event({ SUMMARY: "Dentista\\, Valentina\\; 16h\\nlevar carteirinha" }));
  assert.equal(e.summary, "Dentista, Valentina; 16h\nlevar carteirinha");
});

test("ignores todos and alarms, which share the same file", () => {
  const text = ics(
    [
      "BEGIN:VTODO\r\nUID:t\r\nSUMMARY:Not an event\r\nEND:VTODO",
      "BEGIN:VEVENT\r\nUID:e\r\nSUMMARY:Real\r\nDTSTART:20260810T140000Z\r\nDTEND:20260810T150000Z\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nEND:VALARM\r\nEND:VEVENT",
    ].join("\r\n"),
  );
  const events = parseIcs(text);

  assert.equal(events.length, 1);
  assert.equal(events[0].summary, "Real");
});

test("an event with no end is a point in time, not an open-ended one", () => {
  const text = ics("BEGIN:VEVENT\r\nUID:p\r\nSUMMARY:Ping\r\nDTSTART:20260810T140000Z\r\nEND:VEVENT");
  const [e] = parseIcs(text);

  assert.equal(e.end, e.start);
});

test("flags a TZID time as floating rather than guessing an offset", () => {
  const text = ics(
    "BEGIN:VEVENT\r\nUID:z\r\nSUMMARY:Local\r\nDTSTART;TZID=America/Sao_Paulo:20260810T140000\r\nDTEND;TZID=America/Sao_Paulo:20260810T150000\r\nEND:VEVENT",
  );
  const [e] = parseIcs(text);

  assert.equal(e.floating, true, "the caller must know this time is unanchored");
});

test("skips an event with an unparseable start rather than inventing one", () => {
  const text = ics("BEGIN:VEVENT\r\nUID:bad\r\nSUMMARY:Broken\r\nDTSTART:tomorrow\r\nEND:VEVENT");
  assert.deepEqual(parseIcs(text), []);
});

test("junk input yields no events instead of throwing", () => {
  assert.deepEqual(parseIcs("not a calendar"), []);
  assert.deepEqual(parseIcs(""), []);
});

test("tolerates bare newlines as well as CRLF", () => {
  const text = event().replace(/\r\n/g, "\n");
  assert.equal(parseIcs(text).length, 1);
});

/* ---------------------------------------------------------------- *
 * Conflicts — the draft's "your dentist clashes with the 14:00"
 * ---------------------------------------------------------------- */

const events = parseIcs(
  ics(
    [
      "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Reunião 14h\r\nDTSTART:20260810T140000Z\r\nDTEND:20260810T150000Z\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Almoço\r\nDTSTART:20260810T120000Z\r\nDTEND:20260810T130000Z\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:c\r\nSUMMARY:Feriado\r\nDTSTART;VALUE=DATE:20260812\r\nDTEND;VALUE=DATE:20260813\r\nEND:VEVENT",
    ].join("\r\n"),
  ),
);

test("finds an overlapping event", () => {
  const hits = conflictsWith(events, { start: "2026-08-10T14:30:00Z", end: "2026-08-10T15:30:00Z" });
  assert.deepEqual(hits.map((e) => e.summary), ["Reunião 14h"]);
});

test("an event that merely touches is not a conflict", () => {
  const hits = conflictsWith(events, { start: "2026-08-10T15:00:00Z", end: "2026-08-10T16:00:00Z" });
  assert.deepEqual(hits, []);
});

test("a fully enclosed slot conflicts", () => {
  const hits = conflictsWith(events, { start: "2026-08-10T14:10:00Z", end: "2026-08-10T14:20:00Z" });
  assert.equal(hits.length, 1);
});

test("a free window conflicts with nothing", () => {
  assert.deepEqual(conflictsWith(events, { start: "2026-08-10T16:00:00Z", end: "2026-08-10T17:00:00Z" }), []);
});

test("an all-day event conflicts with anything that day", () => {
  const hits = conflictsWith(events, { start: "2026-08-12T09:00:00Z", end: "2026-08-12T09:30:00Z" });
  assert.deepEqual(hits.map((e) => e.summary), ["Feriado"]);
});

test("a date with no time checks the whole day", () => {
  const hits = conflictsWith(events, { date: "2026-08-10" });
  assert.deepEqual(hits.map((e) => e.summary).sort(), ["Almoço", "Reunião 14h"]);
});

/* ---------------------------------------------------------------- *
 * Agenda
 * ---------------------------------------------------------------- */

test("agenda for a day is chronological", () => {
  assert.deepEqual(agendaFor(events, "2026-08-10").map((e) => e.summary), ["Almoço", "Reunião 14h"]);
});

test("agenda for an empty day is empty", () => {
  assert.deepEqual(agendaFor(events, "2026-08-11"), []);
});

test("agenda includes an all-day event on its day", () => {
  assert.deepEqual(agendaFor(events, "2026-08-12").map((e) => e.summary), ["Feriado"]);
});
