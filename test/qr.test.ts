import { test } from "node:test";
import assert from "node:assert/strict";

import { QrTooLong, qrMatrix } from "../agent/lib/qr.ts";

/**
 * The pairing symbol.
 *
 * These are structural assertions, not a decode: what can be checked without a
 * second implementation is that the symbol has the shape the standard requires
 * — the three finder patterns, the timing rows, a plausible version for the
 * payload — and that a payload which cannot be encoded FAILS rather than
 * producing a symbol that scans into half a pairing code.
 */

/** Roughly the shape whatsmeow emits: ref, keys, base64 with padding. */
const PAYLOAD =
  "2@x1Kf9pQ7t+abcdEFGH/ijkl==,MNOpqrST0123456789abcdefghijklmn=,OPqrSTuvWX+yz/012345678==";

test("a payload becomes a square grid", () => {
  const { size, modules } = qrMatrix(PAYLOAD);
  assert.equal(modules.length, size);
  for (const row of modules) assert.equal(row.length, size);
});

test("the version is one of the standard sizes", () => {
  // 21 for version 1, then +4 per version. A size outside that set means the
  // grid was assembled wrongly, whatever the codec returned.
  const { size } = qrMatrix(PAYLOAD);
  assert.equal((size - 21) % 4, 0, `size ${size} is not a QR version`);
  assert.ok(size >= 21 && size <= 177);
});

test("all three finder patterns are present, and the fourth corner is not", () => {
  const { size, modules } = qrMatrix(PAYLOAD);

  const finderAt = (top: number, left: number) => {
    // The 7×7 finder: a dark ring, a light ring, a 3×3 dark core.
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const expected = ring || inner;
        if (modules[top + r][left + c] !== expected) return false;
      }
    }
    return true;
  };

  assert.ok(finderAt(0, 0), "top-left finder");
  assert.ok(finderAt(0, size - 7), "top-right finder");
  assert.ok(finderAt(size - 7, 0), "bottom-left finder");
  // A symbol with four finders would be unreadable: orientation is derived from
  // the corner that does NOT have one.
  assert.ok(!finderAt(size - 7, size - 7), "bottom-right must have no finder");
});

test("the timing patterns alternate", () => {
  const { size, modules } = qrMatrix(PAYLOAD);
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(modules[6][i], i % 2 === 0, `horizontal timing at ${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `vertical timing at ${i}`);
  }
});

test("a longer payload needs a bigger symbol", () => {
  const short = qrMatrix("2@short").size;
  const long = qrMatrix(PAYLOAD.repeat(4)).size;
  assert.ok(long > short, `${long} should exceed ${short}`);
});

test("the same payload always encodes identically", () => {
  // The stream re-renders every twenty seconds; a symbol that changed without
  // the code changing would be a repaint the operator reads as a new code.
  assert.deepEqual(qrMatrix(PAYLOAD), qrMatrix(PAYLOAD));
});

test("an empty payload is refused rather than encoded", () => {
  assert.throws(() => qrMatrix(""), QrTooLong);
});

test("a payload too long for any symbol fails loudly", () => {
  // The alternative is a symbol encoding a truncated pairing code, which fails
  // at the phone with nothing to explain it.
  assert.throws(() => qrMatrix("x".repeat(8000)), QrTooLong);
});
