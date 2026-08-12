import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_PROMPT_CHARS,
  SIZES,
  apiErrorMessage,
  decodeImage,
  generateImage,
  imageRequest,
  loadImage,
  storeImage,
} from "../agent/lib/imagegen.ts";

/**
 * Turning a sentence into a picture, and keeping the picture until it is sent.
 *
 * Two things here are worth holding down with tests. The first is that the
 * response is DECODED rather than trusted: OpenAI can answer 200 with a URL
 * instead of bytes, with an empty payload, or with something that is not an
 * image at all, and each of those becomes a broken attachment on somebody's
 * phone if it is passed straight through. The second is the store: an id that
 * addresses a file on disk is an id that can address the wrong file, so the
 * traversal cases are here rather than left to a reviewer's imagination.
 *
 * The network is injected throughout, so none of this costs an API call.
 */

/** The first bytes of each container, which is how a decode tells them apart. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP")]);

/** A fake OpenAI that answers with one image and records what it was asked. */
function fakeOpenAI(bytes: Buffer = PNG, status = 200) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: "that prompt was rejected" } }), { status });
    }
    return new Response(
      JSON.stringify({ created: 1, data: [{ b64_json: bytes.toString("base64") }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/* ── the request ───────────────────────────────────────────────────── */

test("the request names a model, one image, and carries the key only in the header", () => {
  const request = imageRequest({ prompt: "a red bicycle", key: "sk-test" });
  const body = JSON.parse(String(request.init.body));

  assert.match(request.url, /^https:\/\/api\.openai\.com\/v1\/images\/generations$/);
  assert.equal(request.init.method, "POST");
  assert.equal((request.init.headers as Record<string, string>).authorization, "Bearer sk-test");
  assert.equal(body.model, "gpt-image-1");
  assert.equal(body.prompt, "a red bicycle");
  assert.equal(body.n, 1);
  assert.ok(!JSON.stringify(request.url).includes("sk-test"), "the key must never be in the URL");
});

test("the friendly sizes map onto the sizes the API actually accepts", () => {
  assert.equal(JSON.parse(String(imageRequest({ prompt: "x", key: "k", size: "square" }).init.body)).size, "1024x1024");
  assert.equal(JSON.parse(String(imageRequest({ prompt: "x", key: "k", size: "portrait" }).init.body)).size, "1024x1536");
  assert.equal(JSON.parse(String(imageRequest({ prompt: "x", key: "k", size: "landscape" }).init.body)).size, "1536x1024");
  // Every alias the tool offers has to resolve, or the API answers 400.
  for (const value of Object.values(SIZES)) assert.match(value, /^(auto|\d{3,4}x\d{3,4})$/);
});

test("a transparent background is asked for as PNG, because JPEG has no alpha", () => {
  const body = JSON.parse(String(imageRequest({ prompt: "a logo", key: "k", background: "transparent" }).init.body));

  assert.equal(body.background, "transparent");
  assert.equal(body.output_format, "png");
});

test("an opaque image is JPEG, so it arrives as a photo and not a several-megabyte PNG", () => {
  const body = JSON.parse(String(imageRequest({ prompt: "a beach", key: "k" }).init.body));

  assert.equal(body.output_format, "jpeg");
  assert.equal(typeof body.output_compression, "number");
});

/* ── reading the answer ────────────────────────────────────────────── */

test("the API's own message survives, rather than 300 characters of envelope", () => {
  assert.match(apiErrorMessage(400, JSON.stringify({ error: { message: "safety system" } })), /safety system/);
  assert.match(apiErrorMessage(502, "<html>gateway</html>"), /502/);
});

test("each container is recognised from its bytes", () => {
  assert.equal(decodeImage({ data: [{ b64_json: PNG.toString("base64") }] }).mimetype, "image/png");
  assert.equal(decodeImage({ data: [{ b64_json: JPEG.toString("base64") }] }).mimetype, "image/jpeg");
  assert.equal(decodeImage({ data: [{ b64_json: WEBP.toString("base64") }] }).mimetype, "image/webp");
});

test("an answer with no bytes in it is a failure, not an empty picture", () => {
  // A URL instead of bytes is what dall-e answers in its default mode. It is a
  // 200, and passing it on sends a JSON fragment as a photo.
  assert.throws(() => decodeImage({ data: [{ url: "https://example.test/i.png" }] }), /no image data/i);
  assert.throws(() => decodeImage({ data: [] }), /no image/i);
  assert.throws(() => decodeImage({}), /no image/i);
  assert.throws(() => decodeImage({ data: [{ b64_json: "" }] }), /no image/i);
});

test("bytes that are not an image are refused before they can be sent", () => {
  const notAnImage = Buffer.from("<!doctype html><title>error</title>").toString("base64");

  assert.throws(() => decodeImage({ data: [{ b64_json: notAnImage }] }), /not a PNG, JPEG or WebP/);
});

/* ── the call ──────────────────────────────────────────────────────── */

test("a generated image comes back with its bytes, its type and what was asked for", async () => {
  const fake = fakeOpenAI(JPEG);
  const image = await generateImage(
    { prompt: "a red bicycle", size: "portrait" },
    { fetch: fake.fetchImpl, key: "sk-test", retryDelayMs: 0 },
  );

  assert.equal(image.mimetype, "image/jpeg");
  assert.deepEqual(Buffer.from(image.bytes), JPEG);
  assert.equal(image.size, "1024x1536");
  assert.equal(fake.calls.length, 1);
});

test("with no key nothing is attempted, and the missing variable is named", async () => {
  const fake = fakeOpenAI();
  await assert.rejects(
    generateImage({ prompt: "x" }, { fetch: fake.fetchImpl, key: "", retryDelayMs: 0 }),
    /OPENAI_API_KEY/,
  );
  assert.equal(fake.calls.length, 0, "a missing key is configuration, not a request");
});

test("an empty prompt and an oversized one are both refused locally", async () => {
  const fake = fakeOpenAI();
  const deps = { fetch: fake.fetchImpl, key: "sk-test", retryDelayMs: 0 };

  await assert.rejects(generateImage({ prompt: "   " }, deps), /nothing to draw/i);
  await assert.rejects(generateImage({ prompt: "x".repeat(MAX_PROMPT_CHARS + 1) }, deps), /characters/);
  assert.equal(fake.calls.length, 0);
});

test("a refusal is reported as a refusal and is not retried", async () => {
  const fake = fakeOpenAI(PNG, 400);

  await assert.rejects(
    generateImage({ prompt: "something disallowed" }, { fetch: fake.fetchImpl, key: "sk-test", retryDelayMs: 0 }),
    /that prompt was rejected/,
  );
  assert.equal(fake.calls.length, 1, "a 400 is an answer; retrying it only makes it slow");
});

test("a rate limit is retried", async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    if (attempts < 2) return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 });
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: PNG.toString("base64") }] }), { status: 200 });
  }) as typeof fetch;

  const image = await generateImage({ prompt: "x" }, { fetch: fetchImpl, key: "sk-test", retryDelayMs: 0 });

  assert.equal(attempts, 2);
  assert.equal(image.mimetype, "image/png");
});

/* ── where it waits until it is sent ───────────────────────────────── */

test("a stored image comes back byte for byte, with what it was made from", async () => {
  process.env.WA_IMAGE_DIR = await mkdtemp(join(tmpdir(), "wa-img-"));

  const saved = await storeImage({ bytes: PNG, mimetype: "image/png", prompt: "a red bicycle", size: "1024x1024" });
  const loaded = await loadImage(saved.id);

  assert.match(saved.id, /^img-[a-z0-9]+$/);
  assert.deepEqual(Buffer.from(loaded.bytes), PNG);
  assert.equal(loaded.mimetype, "image/png");
  assert.equal(loaded.prompt, "a red bicycle");
});

test("an id that is not one this agent issued reads nothing off the disk", async () => {
  process.env.WA_IMAGE_DIR = await mkdtemp(join(tmpdir(), "wa-img-"));
  await storeImage({ bytes: PNG, mimetype: "image/png", prompt: "p", size: "1024x1024" });

  for (const id of ["../../etc/passwd", "img-../secret", "/etc/passwd", "img-missing"]) {
    await assert.rejects(loadImage(id), /no image/i, id);
  }
});

test("the extension follows the bytes, so the file on the phone is named honestly", async () => {
  process.env.WA_IMAGE_DIR = await mkdtemp(join(tmpdir(), "wa-img-"));
  await storeImage({ bytes: JPEG, mimetype: "image/jpeg", prompt: "p", size: "1024x1024" });

  const files = await readdir(process.env.WA_IMAGE_DIR);
  assert.ok(files.some((name) => name.endsWith(".jpeg")), files.join(", "));
});
