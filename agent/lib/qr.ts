/**
 * The pairing payload, as a grid of modules the browser can paint.
 *
 * ── Why a dependency here, in a project that deletes them ───────────────────
 * `swatch.js` hand-writes a PNG encoder rather than take an image library, and
 * that is the right call for a rectangle of one colour: sixty lines, and wrong
 * output is visible instantly. A QR symbol is not that. It is a specified codec
 * — Reed-Solomon error correction, eight mask patterns scored against four
 * penalty rules, version selection, format and version information — and a
 * subtly wrong one is not visibly wrong, it simply does not scan.
 *
 * There is no independent QR implementation on this machine to check a
 * hand-written encoder against, so shipping one would mean shipping unverified
 * output as the first step of linking a real WhatsApp account. `qrcode-
 * generator` is MIT, has no transitive dependencies at all, and is a codec
 * rather than a convenience wrapper.
 *
 * ── Why the matrix crosses the wire, and not an image ───────────────────────
 * The browser paints the cells. Encoding to PNG here would mean base64 in an
 * event stream that already rotates every twenty seconds; a boolean grid is
 * smaller, and the page can size it to the viewport without re-fetching.
 */

import qrcode from "qrcode-generator";

export interface QrMatrix {
  /** Modules per side, excluding the quiet zone. */
  readonly size: number;
  /** Row-major, `true` where a module is dark. */
  readonly modules: boolean[][];
}

/**
 * Error correction level `L`.
 *
 * The lowest, deliberately: a pairing code is scanned once, at close range, off
 * a screen rather than off a printed surface that might be damaged. Redundancy
 * buys nothing here, and every level above L makes the symbol denser — which on
 * a phone camera is the thing that actually costs a scan.
 */
const ERROR_CORRECTION = "L" as const;

export class QrTooLong extends Error {}

/**
 * One payload as a module grid.
 *
 * Version 0 asks the codec to choose the smallest symbol that fits. A payload
 * too long for any version throws rather than returning a truncated symbol,
 * because a QR that encodes half a pairing code is one that fails at the phone
 * with no explanation.
 */
export function qrMatrix(payload: string): QrMatrix {
  if (!payload) throw new QrTooLong("there is no payload to encode");

  let qr: ReturnType<typeof qrcode>;
  try {
    qr = qrcode(0, ERROR_CORRECTION);
    qr.addData(payload);
    qr.make();
  } catch (error) {
    throw new QrTooLong(
      `this pairing payload (${payload.length} characters) does not fit in a QR symbol: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const size = qr.getModuleCount();
  const modules: boolean[][] = [];
  for (let row = 0; row < size; row += 1) {
    const cells: boolean[] = [];
    for (let column = 0; column < size; column += 1) cells.push(qr.isDark(row, column));
    modules.push(cells);
  }
  return { size, modules };
}
