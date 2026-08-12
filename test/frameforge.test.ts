import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ArtifactError,
  MAX_ARTIFACT_BYTES,
  readArtifact,
  readRenderDefects,
  resolveArtifact,
} from "../agent/lib/frameforge.ts";

/**
 * Two things are being defended here.
 *
 * The first is the URI-to-path mapping, which must agree exactly with the
 * server's own (`frameforge_mcp/sessions.py`): page 1 is `p001.png`, and the
 * document is `generated.fg.yaml`/`document.pdf`. A mapping that drifts sends
 * the wrong file or none at all, and the URI is model-supplied, so it also has
 * to be a boundary — a session id is a name, never a path.
 *
 * The second is the delivery gate. `ok: true` is not "usable", and the whole
 * point of reading diagnostics.json in code is that a missing file reports as
 * unverified rather than as clean.
 */

const root = "/work/sessions";

test("a rendered page resolves to the file the renderer actually wrote", () => {
  const artifact = resolveArtifact("frameforge://session/menu/page/1.png", root);

  assert.equal(artifact.path, "/work/sessions/menu/p001.png");
  assert.equal(artifact.mimetype, "image/png");
  assert.equal(artifact.kind, "image");
  assert.equal(artifact.sessionId, "menu");
  assert.equal(artifact.page, 1);
});

test("page numbers are zero-padded to three, as the renderer names them", () => {
  assert.equal(resolveArtifact("frameforge://session/deck/page/12.png", root).path, "/work/sessions/deck/p012.png");
  assert.equal(resolveArtifact("frameforge://session/deck/page/7.png", root).path, "/work/sessions/deck/p007.png");
});

test("the PDF is a document, not an image — WhatsApp shows a file row", () => {
  const artifact = resolveArtifact("frameforge://session/report/document.pdf", root);

  assert.equal(artifact.path, "/work/sessions/report/document.pdf");
  assert.equal(artifact.kind, "document");
  assert.equal(artifact.filename, "document.pdf");
  assert.equal(artifact.page, undefined);
});

test("only deliverables resolve: working notes are refused by name", () => {
  for (const uri of [
    "frameforge://session/x/diagnostics.json",
    "frameforge://session/x/document.yaml",
    "frameforge://session/x/page/1.svg",
    "frameforge://session/x/workspace.json",
  ]) {
    assert.throws(() => resolveArtifact(uri, root), ArtifactError, uri);
  }
});

test("a session id is a name, never a path", () => {
  for (const uri of [
    "frameforge://session/a b/page/1.png",
    "frameforge://session/.hidden/page/1.png",
    "frameforge://session//page/1.png",
  ]) {
    assert.throws(() => resolveArtifact(uri, root), ArtifactError, uri);
  }
});

test("traversal never leaves the session root, however it is spelled", () => {
  // A URI parser folds `..` away before this code sees it, so the guarantee
  // being asserted is containment, not rejection: whatever a hostile URI
  // resolves to, it is a file under the root or it is an error.
  for (const uri of [
    "frameforge://session/../../etc/page/1.png",
    "frameforge://session/%2e%2e%2f%2e%2e/page/1.png",
    "frameforge://session/x/page/%2e%2e%2f%2e%2e%2fpasswd.png",
    "frameforge://session/x/../../document.pdf",
  ]) {
    let path: string | undefined;
    try {
      path = resolveArtifact(uri, root).path;
    } catch (error) {
      assert.ok(error instanceof ArtifactError, uri);
      continue;
    }
    assert.match(path, /^\/work\/sessions\/[^/]+\/(p\d{3}\.png|document\.pdf)$/, uri);
  }
});

test("a URI from somewhere else is not a render", () => {
  for (const uri of ["/work/sessions/x/p001.png", "file:///etc/passwd", "frameforge://other/x/page/1.png", "nonsense"]) {
    assert.throws(() => resolveArtifact(uri, root), ArtifactError, uri);
  }
});

test("page 0 and page -1 are not pages", () => {
  assert.throws(() => resolveArtifact("frameforge://session/x/page/0.png", root), ArtifactError);
  assert.throws(() => resolveArtifact("frameforge://session/x/page/-1.png", root), ArtifactError);
});

test("a clean render reports no defects, and reports that it was checked", async () => {
  const dir = await session("clean", {
    ok: true,
    design: { unpainted: 0, unreadable: 0, collisions: 0 },
    diagnostics: { overflow: [], skipped_objects: [], truncations: [] },
  });

  const health = await readRenderDefects("clean", dir);

  assert.deepEqual(health.defects, []);
  assert.equal(health.verified, true);
  assert.equal(health.rendered, true);
});

test("every defect the page cannot show is named", async () => {
  const dir = await session("bad", {
    ok: true,
    design: { unpainted: 2, unreadable: 1, collisions: 3 },
    diagnostics: { overflow: [{}], skipped_objects: [{}, {}], truncations: [{}] },
  });

  const health = await readRenderDefects("bad", dir);

  assert.equal(health.defects.length, 6);
  assert.match(health.defects.join(" | "), /2 objects painted no ink/);
  assert.match(health.defects.join(" | "), /1 legibility failure/);
  assert.match(health.defects.join(" | "), /3 text collisions/);
  assert.match(health.defects.join(" | "), /1 overflow signal/);
  assert.match(health.defects.join(" | "), /2 objects dropped/);
  assert.match(health.defects.join(" | "), /1 text truncation/);
});

test("a failed render is reported as failed", async () => {
  const dir = await session("broken", { ok: false, design: {}, diagnostics: {} });

  assert.equal((await readRenderDefects("broken", dir)).rendered, false);
});

test("no diagnostics file means UNVERIFIED, which is not the same as clean", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-"));

  const health = await readRenderDefects("never-rendered", dir);

  assert.equal(health.verified, false);
  assert.deepEqual(health.defects, []);
});

test("unparseable diagnostics are unverified too, not silently clean", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-"));
  await mkdir(join(dir, "torn"), { recursive: true });
  await writeFile(join(dir, "torn", "diagnostics.json"), "{ not json");

  assert.equal((await readRenderDefects("torn", dir)).verified, false);
});

test("a missing artifact says the session may be gone, not 'ENOENT'", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-"));

  await assert.rejects(
    readArtifact(resolveArtifact("frameforge://session/gone/page/1.png", dir)),
    (error: unknown) => error instanceof ArtifactError && /render it again/i.test((error as Error).message),
  );
});

test("an empty render is refused before the bridge is asked to send it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-"));
  await mkdir(join(dir, "empty"), { recursive: true });
  await writeFile(join(dir, "empty", "p001.png"), "");

  await assert.rejects(
    readArtifact(resolveArtifact("frameforge://session/empty/page/1.png", dir)),
    ArtifactError,
  );
});

test("an artifact the bridge could not carry is refused with the limit named", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-"));
  await mkdir(join(dir, "huge"), { recursive: true });
  await writeFile(join(dir, "huge", "p001.png"), Buffer.alloc(MAX_ARTIFACT_BYTES + 1));

  await assert.rejects(
    readArtifact(resolveArtifact("frameforge://session/huge/page/1.png", dir)),
    (error: unknown) => error instanceof ArtifactError && /attachment limit/.test((error as Error).message),
  );
});

test("bytes come back exactly as written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ff-"));
  await mkdir(join(dir, "ok"), { recursive: true });
  await writeFile(join(dir, "ok", "p001.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const bytes = await readArtifact(resolveArtifact("frameforge://session/ok/page/1.png", dir));

  assert.deepEqual(Buffer.from(bytes), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

/** Write one session's diagnostics.json under a fresh root, and return the root. */
async function session(id: string, diagnostics: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ff-"));
  await mkdir(join(dir, id), { recursive: true });
  await writeFile(join(dir, id, "diagnostics.json"), JSON.stringify(diagnostics));
  return dir;
}
