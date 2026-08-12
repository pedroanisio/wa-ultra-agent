/**
 * The state banner: a solid block of colour, sent as an image.
 *
 * ── Why an image and not just the emoji ─────────────────────────────────────
 * A marker at the head of a line is easy to miss in a chat you are scrolling,
 * and easier still to miss on a phone showing a notification preview. An image
 * is a block: it interrupts the wall of text, it survives the notification, and
 * it is unmistakable at a glance from across a room. Entering a state is the one
 * moment the operator must not be confused about — everything they type next is
 * read by that state — so the entry is signalled with a block of the state's
 * colour and the exit clears it.
 *
 * ── Why it is written by hand ───────────────────────────────────────────────
 * A PNG encoder is about sixty lines when the image is a single colour, and the
 * alternative is a dependency in a service that currently has none. This repo
 * just deleted Playwright to stop shipping a browser; adding an image library to
 * draw a rectangle would be the same mistake in miniature.
 *
 * The output is a valid 8-bit RGB PNG. Nothing here is clever: one IHDR, one
 * IDAT holding zlib-deflated scanlines, one IEND, each with its CRC.
 */

import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32, table built once. The PNG spec's polynomial, nothing exotic. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** `#RRGGBB` → three bytes. Throws rather than guessing at a malformed colour. */
export function parseColor(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!match) throw new Error(`not a colour: ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * A solid block, as PNG bytes.
 *
 * Wide and short by default: a banner reads as a divider between what came
 * before and the state you have just entered, where a square reads as a photo.
 */
export function solidPng(hex, { width = 720, height = 120 } = {}) {
  const [r, g, b] = parseColor(hex);

  // One filter byte (0 = None) per scanline, then RGB triples.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** What `POST /send/media` wants: the same block, base64. */
export function solidPngBase64(hex, options) {
  return solidPng(hex, options).toString("base64");
}
