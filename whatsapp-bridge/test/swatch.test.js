import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

import { parseColor, solidPng, solidPngBase64 } from "../src/swatch.js";

/**
 * The banner is written by hand rather than by a dependency, so these tests are
 * what stands between "a PNG" and "bytes WhatsApp will reject".
 */

function chunks(png) {
  const found = {};
  let i = 8;
  while (i < png.length) {
    const length = png.readUInt32BE(i);
    const type = png.subarray(i + 4, i + 8).toString("ascii");
    found[type] = (found[type] ?? Buffer.alloc(0));
    found[type] = Buffer.concat([found[type], png.subarray(i + 8, i + 8 + length)]);
    i += 12 + length;
  }
  return found;
}

test("png: carries the signature every decoder checks first", () => {
  const png = solidPng("#12B886");
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("png: declares 8-bit truecolour at the requested size", () => {
  const { IHDR } = chunks(solidPng("#12B886", { width: 64, height: 16 }));
  assert.equal(IHDR.readUInt32BE(0), 64);
  assert.equal(IHDR.readUInt32BE(4), 16);
  assert.equal(IHDR[8], 8, "bit depth");
  assert.equal(IHDR[9], 2, "colour type: truecolour");
});

test("png: every pixel is the colour that was asked for", () => {
  const { IDAT } = chunks(solidPng("#F08C00", { width: 4, height: 3 }));
  const raw = inflateSync(IDAT);
  const stride = 4 * 3 + 1;
  for (let y = 0; y < 3; y++) {
    assert.equal(raw[y * stride], 0, "each scanline must declare filter None");
    for (let x = 0; x < 4; x++) {
      const at = y * stride + 1 + x * 3;
      assert.deepEqual([raw[at], raw[at + 1], raw[at + 2]], [0xf0, 0x8c, 0x00]);
    }
  }
});

test("png: ends with IEND, so a decoder knows it is whole", () => {
  const png = solidPng("#4C6EF5");
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString("ascii"), "IEND");
});

test("colour: accepts hex with or without the hash", () => {
  assert.deepEqual(parseColor("#7950F2"), parseColor("7950f2"));
});

test("colour: refuses anything it would otherwise have to guess at", () => {
  for (const bad of ["", "#fff", "red", "#12B88", null, undefined]) {
    assert.throws(() => parseColor(bad), /not a colour/);
  }
});

test("base64: is what POST /send/media wants, and round-trips", () => {
  const encoded = solidPngBase64("#12B886", { width: 8, height: 8 });
  assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
  assert.deepEqual(Buffer.from(encoded, "base64"), solidPng("#12B886", { width: 8, height: 8 }));
});
