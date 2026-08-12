import { test } from "node:test";
import assert from "node:assert/strict";

import { describeSpan, describeWindow, formatDay } from "../agent/lib/archive-span.ts";

/**
 * The words the model repeats when asked how far back it can see.
 *
 * This exists because the honest answer has three shapes and only one of them
 * is "from X to Y": an archive can hold nothing dated at all, and it can hold
 * rows whose timestamps never parsed — which are invisible to the bounds and
 * would otherwise be quietly excluded from a sentence that claims to describe
 * the whole thing.
 */

const span = (over: Partial<Parameters<typeof describeSpan>[0] & object> = {}) => ({
  oldest: "2026-06-03T09:00:00.000Z",
  newest: "2026-08-11T23:14:00.000Z",
  days: 69,
  dated: 8_824,
  undated: 0,
  ...over,
});

test("a covered period reads as dates, not as timestamps", () => {
  const line = describeSpan(span());

  assert.match(line, /3 Jun 2026 to 11 Aug 2026/);
  assert.match(line, /69 days/);
});

test("one day is not '1 days'", () => {
  assert.match(describeSpan(span({ days: 1 })), /\(1 day\)/);
});

test("an archive with nothing dated says exactly that", () => {
  assert.match(describeSpan(span({ oldest: null, newest: null, days: 0 })), /no dated messages/);
  assert.match(describeSpan(null), /no dated messages/);
});

test("undated messages are declared, because the span cannot see them", () => {
  const line = describeSpan(span({ undated: 12 }));

  assert.match(line, /3 Jun 2026 to 11 Aug 2026/);
  assert.match(line, /12 messages carry no usable timestamp/);
  assert.match(line, /rather than presenting the range as the whole archive/);
});

test("a window inside the archive needs no caveat", () => {
  assert.equal(describeWindow(span(), "2026-07-01T00:00:00.000Z"), undefined);
});

test("a window reaching past the archive says what is actually there", () => {
  // "check the last 45 days" against an archive nine days deep is answerable,
  // and the answer is "nine days is all there is" — never an empty list
  // presented as nothing owed.
  const line = describeWindow(span({ oldest: "2026-08-02T00:00:00.000Z" }), "2026-06-27T00:00:00.000Z");

  assert.ok(line);
  assert.match(line, /only reaches back to 2 Aug 2026/);
  assert.match(line, /unread, not nothing/);
});

test("no window asked, no window claimed", () => {
  assert.equal(describeWindow(span(), undefined), undefined);
});

test("a date renders the same way wherever the server thinks it is", () => {
  // UTC, explicitly: a container in a different zone must not report a
  // different oldest day for the same archive.
  assert.equal(formatDay("2026-06-03T23:30:00.000Z"), "3 Jun 2026");
  assert.equal(formatDay("2026-06-03T00:30:00.000Z"), "3 Jun 2026");
});
