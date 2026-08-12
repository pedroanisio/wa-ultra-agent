import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The delivery gate.
 *
 * A render that reports invisible objects, unreadable text, collisions or
 * clipped content is a render that must not become a photo on somebody's phone
 * — and the model, having just looked at a thumbnail and liked it, is the last
 * thing that should be trusted to enforce that. So the tool re-reads the
 * renderer's own diagnostics from disk. These tests hold that line: what is
 * blocked, what is sent, and that a session with no diagnostics at all reports
 * as unchecked rather than as fine.
 */

process.env.WA_BRIDGE_TOKEN ??= "test-token";
process.env.WA_BRIDGE_URL ??= "http://bridge.test";

const tool = async () => (await import("../agent/tools/whatsapp_deliver_render.ts")).default;
const ctx = {} as never;

interface Captured {
  path: string;
  body: Record<string, unknown>;
}

function capture(reply: unknown) {
  const original = globalThis.fetch;
  const calls: Captured[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      path: new URL(String(input)).pathname,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { calls, restore: () => void (globalThis.fetch = original) };
}

/** A session on disk: one rendered page, and whatever the render said about it. */
async function session(
  id: string,
  diagnostics: unknown | null,
  file: { name: string; bytes: Buffer } = { name: "p001.png", bytes: Buffer.from([0x89, 0x50]) },
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ff-"));
  await mkdir(join(root, id), { recursive: true });
  await writeFile(join(root, id, file.name), file.bytes);
  if (diagnostics !== null) {
    await writeFile(join(root, id, "diagnostics.json"), JSON.stringify(diagnostics));
  }
  process.env.WA_FRAMEFORGE_SESSION_ROOT = root;
}

const CLEAN = {
  ok: true,
  design: { unpainted: 0, unreadable: 0, collisions: 0 },
  diagnostics: { overflow: [], skipped_objects: [], truncations: [] },
};

const INVISIBLE = {
  ok: true,
  design: { unpainted: 1, unreadable: 0, collisions: 0 },
  diagnostics: { overflow: [], skipped_objects: [], truncations: [] },
};

test("a defective render is not sent, and the defect is named", async () => {
  await session("menu", INVISIBLE);
  const fake = capture({});
  try {
    const deliver = await tool();
    const result = await deliver.execute(
      { uri: "frameforge://session/menu/page/1.png", force: false },
      ctx,
    );

    assert.equal(result.ok, false);
    assert.equal(fake.calls.length, 0, "nothing may reach the bridge");
    assert.match(deliver.toModelOutput(result).value, /painted no ink/);
    assert.match(deliver.toModelOutput(result).value, /NOT sent/);
  } finally {
    fake.restore();
  }
});

test("force sends it anyway, and says what was overridden", async () => {
  await session("menu", INVISIBLE);
  const fake = capture({ id: "1", sentAt: "now", chat: "Me", archived: true });
  try {
    const deliver = await tool();
    const result = await deliver.execute(
      { uri: "frameforge://session/menu/page/1.png", force: true },
      ctx,
    );

    assert.equal(result.ok, true);
    assert.equal(fake.calls[0].path, "/send/self/media");
    assert.match(deliver.toModelOutput(result).value, /Sent with known defects/);
  } finally {
    fake.restore();
  }
});

test("a failed render has nothing worth sending", async () => {
  await session("broken", { ok: false, design: {}, diagnostics: {} });
  const fake = capture({});
  try {
    const result = await (await tool()).execute(
      { uri: "frameforge://session/broken/page/1.png", force: false },
      ctx,
    );

    assert.equal(result.ok, false);
    assert.equal(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

test("a clean page goes to the user's own chat as an image", async () => {
  await session("menu", CLEAN);
  const fake = capture({ id: "1", sentAt: "now", chat: "Me", archived: true });
  try {
    const deliver = await tool();
    const result = await deliver.execute(
      { uri: "frameforge://session/menu/page/1.png", caption: "this week", force: false },
      ctx,
    );

    assert.equal(fake.calls[0].path, "/send/self/media");
    assert.equal(fake.calls[0].body.mimetype, "image/png");
    assert.equal(fake.calls[0].body.kind, "image");
    assert.equal(fake.calls[0].body.caption, "this week");
    assert.equal(fake.calls[0].body.dataBase64, Buffer.from([0x89, 0x50]).toString("base64"));
    assert.equal(result.ok, true);
    assert.match(deliver.toModelOutput(result).value, /on their phone/);
  } finally {
    fake.restore();
  }
});

test("a PDF for a contact goes out as a document, through the allowlisted route", async () => {
  await session("report", CLEAN, { name: "document.pdf", bytes: Buffer.from("%PDF-1.7") });
  const fake = capture({ sent: true, to: "Fabio Souza", at: "now", exactMatch: true });
  try {
    const deliver = await tool();
    const result = await deliver.execute(
      { uri: "frameforge://session/report/document.pdf", to: "Fabio Souza", force: false },
      ctx,
    );

    assert.equal(fake.calls[0].path, "/send/media");
    assert.equal(fake.calls[0].body.to, "Fabio Souza");
    assert.equal(fake.calls[0].body.kind, "document");
    assert.equal(fake.calls[0].body.filename, "document.pdf");
    assert.equal(fake.calls[0].body.mimetype, "application/pdf");
    assert.equal(result.ok, true);
    assert.match(deliver.toModelOutput(result).value, /cannot be recalled/);
  } finally {
    fake.restore();
  }
});

test("a loose name match is reported, because the send already happened", async () => {
  await session("report", CLEAN, { name: "document.pdf", bytes: Buffer.from("%PDF-1.7") });
  const fake = capture({ sent: true, to: "Ana Paula", at: "now", exactMatch: false });
  try {
    const deliver = await tool();
    const result = await deliver.execute(
      { uri: "frameforge://session/report/document.pdf", to: "Ana", force: false },
      ctx,
    );

    assert.match(deliver.toModelOutput(result).value, /matched loosely/);
    assert.match(deliver.toModelOutput(result).value, /Ana Paula/);
  } finally {
    fake.restore();
  }
});

test("a session with no diagnostics sends, and says it was never checked", async () => {
  await session("adhoc", null);
  const fake = capture({ id: "1", sentAt: "now", chat: "Me", archived: true });
  try {
    const deliver = await tool();
    const result = await deliver.execute(
      { uri: "frameforge://session/adhoc/page/1.png", force: false },
      ctx,
    );

    assert.equal(result.ok, true);
    assert.match(deliver.toModelOutput(result).value, /NOT machine-checked/);
  } finally {
    fake.restore();
  }
});

test("a URI that is not a render never reaches the bridge", async () => {
  await session("menu", CLEAN);
  const fake = capture({});
  try {
    const deliver = await tool();
    for (const uri of ["frameforge://session/menu/diagnostics.json", "/work/sessions/menu/p001.png"]) {
      const result = await deliver.execute({ uri, force: false }, ctx);
      assert.equal(result.ok, false, uri);
    }
    assert.equal(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});
