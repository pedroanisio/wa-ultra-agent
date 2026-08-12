import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { imageDeps, storeImage } from "../agent/lib/imagegen.ts";

/**
 * Generating a picture, and then sending it.
 *
 * These are two tools rather than one, and that is the thing under test here: a
 * generated image is model output, so it is looked at before it is sent, and
 * nothing reaches a person in one call. The tests hold the seam — what the
 * generate tool hands back for inspection, and what the send tool refuses to
 * address.
 */

process.env.WA_BRIDGE_TOKEN ??= "test-token";
process.env.WA_BRIDGE_URL ??= "http://bridge.test";
// The tools read the key from the environment, as they do in production. The
// fake below answers regardless of what it is.
process.env.OPENAI_API_KEY ??= "sk-test";

const generateTool = async () => (await import("../agent/tools/whatsapp_generate_image.ts")).default;
const sendTool = async () => (await import("../agent/tools/whatsapp_send_image.ts")).default;
const ctx = {} as never;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

// The downscale that produces what the model looks at. Stubbed once for the
// file: real ffmpeg would reject these eight synthetic bytes, and the tool would
// then correctly report the picture as unseen — which is a different test from
// the ones below.
imageDeps.run = async () => ({ stdout: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]), stderr: "", code: 0 });

/**
 * One fake for both hops.
 *
 * OpenAI and the bridge are told apart by hostname, which is also the assertion
 * that matters most: the prompt goes to one of them and the bytes to the other,
 * and neither call may be skipped by the tool taking a shortcut.
 */
function capture({ image = JPEG, bridgeReply = {} as unknown, openaiStatus = 200 } = {}) {
  const original = globalThis.fetch;
  const openai: Array<Record<string, unknown>> = [];
  const bridge: Array<{ path: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (url.hostname.includes("openai")) {
      openai.push(body);
      if (openaiStatus !== 200) {
        return new Response(JSON.stringify({ error: { message: "rejected by the safety system" } }), {
          status: openaiStatus,
        });
      }
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: image.toString("base64") }] }), {
        status: 200,
      });
    }

    bridge.push({ path: url.pathname, body });
    return new Response(JSON.stringify(bridgeReply), { status: 200 });
  }) as typeof fetch;

  return { openai, bridge, restore: () => void (globalThis.fetch = original) };
}

async function scratch(): Promise<void> {
  process.env.WA_IMAGE_DIR = await mkdtemp(join(tmpdir(), "wa-img-"));
}

/* ── generating ────────────────────────────────────────────────────── */

test("generating an image sends nothing, and hands the picture back to be looked at", async () => {
  await scratch();
  const fake = capture();
  try {
    const generate = await generateTool();
    const result = await generate.execute({ prompt: "a red bicycle", size: "square" }, ctx);

    assert.equal(result.ok, true);
    assert.equal(fake.bridge.length, 0, "generating is not sending");
    assert.equal(fake.openai[0].prompt, "a red bicycle");

    const shown = generate.toModelOutput(result);
    assert.equal(shown.type, "content");
    assert.ok(
      shown.value.some((part) => part.type === "file"),
      "the model must actually see the image it is about to send",
    );
  } finally {
    fake.restore();
  }
});

test("a refused prompt is reported as a refusal, and nothing is stored", async () => {
  await scratch();
  const fake = capture({ openaiStatus: 400 });
  try {
    const generate = await generateTool();
    const result = await generate.execute({ prompt: "something disallowed" }, ctx);

    assert.equal(result.ok, false);
    assert.match(generate.toModelOutput(result).value, /rejected by the safety system/);
    assert.equal(fake.bridge.length, 0);
  } finally {
    fake.restore();
  }
});

/* ── sending ───────────────────────────────────────────────────────── */

test("with no recipient the image goes to the user's own chat", async () => {
  await scratch();
  const saved = await storeImage({ bytes: JPEG, mimetype: "image/jpeg", prompt: "a red bicycle", size: "1024x1024" });
  const fake = capture({ bridgeReply: { id: "1", sentAt: "now", chat: "Me", archived: true } });
  try {
    const send = await sendTool();
    const result = await send.execute({ id: saved.id, caption: "here" }, ctx);

    assert.equal(fake.bridge[0].path, "/send/self/media");
    assert.equal(fake.bridge[0].body.kind, "image");
    assert.equal(fake.bridge[0].body.mimetype, "image/jpeg");
    assert.equal(fake.bridge[0].body.caption, "here");
    assert.equal(fake.bridge[0].body.dataBase64, JPEG.toString("base64"));
    assert.equal(result.ok, true);
    assert.match(send.toModelOutput(result).value, /own chat/);
  } finally {
    fake.restore();
  }
});

test("a named recipient is a real send, through the allowlisted route", async () => {
  await scratch();
  const saved = await storeImage({ bytes: JPEG, mimetype: "image/jpeg", prompt: "p", size: "1024x1024" });
  const fake = capture({
    bridgeReply: { id: "1", sentAt: "now", requestedRecipient: "Fabio Souza", resolvedName: "Fabio Souza" },
  });
  try {
    const send = await sendTool();
    const result = await send.execute({ id: saved.id, to: "Fabio Souza" }, ctx);

    assert.equal(fake.bridge[0].path, "/send/media");
    assert.equal(fake.bridge[0].body.to, "Fabio Souza");
    assert.equal(result.ok, true);
    assert.match(send.toModelOutput(result).value, /cannot be recalled/);
  } finally {
    fake.restore();
  }
});

test("the chat it actually landed in is what gets reported", async () => {
  await scratch();
  const saved = await storeImage({ bytes: JPEG, mimetype: "image/jpeg", prompt: "p", size: "1024x1024" });
  // A near miss is refused by the bridge rather than warned about, so a reply
  // that comes back at all is one that reached the chat. What the tool must not
  // do is report the string it was HANDED — `resolvedName` is the chat, and the
  // two differ whenever the roster spells a name differently from the user.
  const fake = capture({ bridgeReply: { id: "1", sentAt: "now", requestedRecipient: "ana", resolvedName: "Ana Paula" } });
  try {
    const send = await sendTool();
    const result = await send.execute({ id: saved.id, to: "ana" }, ctx);

    assert.equal(result.ok, true);
    assert.match(send.toModelOutput(result).value, /Ana Paula/);
  } finally {
    fake.restore();
  }
});

test("an id that addresses nothing never reaches the bridge", async () => {
  await scratch();
  const fake = capture({ bridgeReply: {} });
  try {
    const send = await sendTool();
    for (const id of ["img-gone", "../../etc/passwd"]) {
      const result = await send.execute({ id }, ctx);
      assert.equal(result.ok, false, id);
    }
    assert.equal(fake.bridge.length, 0);
  } finally {
    fake.restore();
  }
});

test("sending to another person asks first; sending to the user does not", async () => {
  const { imageSendApproval } = await import("../agent/lib/send-policy.ts");

  assert.equal(imageSendApproval({ toolInput: { to: "Fabio Souza" } }), "user-approval");
  assert.equal(imageSendApproval({ toolInput: {} }), "not-applicable");
  assert.equal(imageSendApproval({ toolInput: { to: "   " } }), "not-applicable");
});
