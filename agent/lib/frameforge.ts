/**
 * Turning a FrameForge session URI into bytes this agent can put on a phone.
 *
 * FrameForge renders into a per-session scratch directory and hands back URIs
 * — `frameforge://session/<id>/page/1.png` — not bytes. The model never sees
 * the on-disk path (the tool result summary strips it), and it could not be
 * trusted with one if it did: a path from a model is a path that can point
 * anywhere. So the mapping from URI to file lives here, in code, and it is the
 * same mapping the server itself uses (`frameforge_mcp/sessions.py`,
 * `_resolve_session_artifact`).
 *
 * The session directory reaches this container because both processes mount the
 * same volume at the same path. Nothing is fetched over the wire; the agent
 * reads the file the renderer just wrote.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

/** Where the FrameForge image writes its sessions — its Dockerfile's own default. */
export const DEFAULT_SESSION_ROOT = "/work/sessions";

/**
 * The bridge accepts a 16 MB attachment, so anything larger cannot be sent at
 * all and is refused here, where the error can name the artifact.
 */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** The server's own session-id grammar. Rejecting `..` falls out of it. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

/** A render artifact that is worth sending to someone: a page, or the PDF. */
export type Artifact = {
  /** Absolute path inside this container. */
  readonly path: string;
  readonly mimetype: string;
  /** WhatsApp's own split: a picture is shown inline, a PDF arrives as a file. */
  readonly kind: "image" | "document";
  /** What the file is called on the recipient's phone. */
  readonly filename: string;
  readonly sessionId: string;
  /** Absent for a whole-document artifact. */
  readonly page?: number;
};

/** A URI this library refuses to resolve, with the reason the model needs. */
export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

/** The configured session root, or the image's default. */
export function sessionRoot(): string {
  const configured = process.env.WA_FRAMEFORGE_SESSION_ROOT?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_SESSION_ROOT;
}

function positivePage(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) throw new ArtifactError(`"${raw}" is not a page number.`);
  const page = Number.parseInt(raw, 10);
  if (page < 1) throw new ArtifactError("page numbers start at 1.");
  return page;
}

/**
 * Resolve a `frameforge://session/...` URI to a file on disk.
 *
 * Only the two artifacts that make sense in a conversation resolve: a rendered
 * page (PNG) and the assembled PDF. The SVG is a vector file no phone previews,
 * and `diagnostics.json`/`document.yaml` are working notes, not deliverables —
 * refusing them here is cheaper than explaining afterwards why a contact
 * received a YAML file.
 */
export function resolveArtifact(uri: string, root: string = sessionRoot()): Artifact {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new ArtifactError(`"${uri}" is not a URI. Copy one from the render result.`);
  }

  if (parsed.protocol !== "frameforge:" || parsed.hostname !== "session") {
    throw new ArtifactError("a deliverable URI starts with frameforge://session/");
  }

  const parts = parsed.pathname
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => decodeURIComponent(part));

  const [sessionId, ...artifact] = parts;
  if (!sessionId || artifact.length === 0) {
    throw new ArtifactError("the URI is missing a session id or an artifact path.");
  }
  if (!SESSION_ID.test(sessionId)) {
    throw new ArtifactError(`"${sessionId}" is not a session id.`);
  }

  const sessionDir = resolve(root, sessionId);
  let file: string;
  let mimetype: string;
  let kind: Artifact["kind"];
  let filename: string;
  let page: number | undefined;

  if (artifact.length === 2 && artifact[0] === "page" && artifact[1].endsWith(".png")) {
    page = positivePage(artifact[1].slice(0, -".png".length));
    file = `p${String(page).padStart(3, "0")}.png`;
    mimetype = "image/png";
    kind = "image";
    filename = `page-${String(page).padStart(3, "0")}.png`;
  } else if (artifact.length === 1 && artifact[0] === "document.pdf") {
    file = "document.pdf";
    mimetype = "application/pdf";
    kind = "document";
    filename = "document.pdf";
  } else {
    throw new ArtifactError(
      `${artifact.join("/")} is not something to send. Deliverable artifacts are ` +
        "frameforge://session/<id>/page/<n>.png and frameforge://session/<id>/document.pdf.",
    );
  }

  const path = resolve(sessionDir, file);
  const inside = relative(resolve(root), path);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new ArtifactError("that URI resolves outside the session root.");
  }

  return { path, mimetype, kind, filename, sessionId, page };
}

/** Where the render's own machine verification was written. */
export function diagnosticsPath(sessionId: string, root: string = sessionRoot()): string {
  return resolve(root, sessionId, "diagnostics.json");
}

/**
 * The defects a render reports about itself, as of its last call.
 *
 * `ok: true` means the render completed, not that it is usable: an object can
 * paint no ink, text can sit on text, a column can lose its last line off the
 * edge of the page. FrameForge measures all three and writes them next to the
 * PNG. Reading them here — rather than trusting the model to have read them —
 * is the point: LLM output is unverified by default, and the file on disk is
 * the verification.
 */
export type RenderDefects = {
  /** False when the last render in this session failed outright. */
  readonly rendered: boolean;
  /** One line per defect, phrased for a person. Empty means nothing was found. */
  readonly defects: readonly string[];
  /** False when no diagnostics file exists — unverified, which is not the same as clean. */
  readonly verified: boolean;
};

type DiagnosticsFile = {
  ok?: boolean;
  design?: { unpainted?: number; unreadable?: number; collisions?: number };
  diagnostics?: {
    overflow?: unknown[];
    skipped_objects?: unknown[];
    truncations?: unknown[];
  };
};

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Read a session's diagnostics and say what is wrong with the last render.
 *
 * A missing or unreadable file is reported as *unverified*, never as clean —
 * the caller decides what to do with that, and silently treating "I could not
 * check" as "there is nothing to find" is the failure this whole module exists
 * to prevent.
 */
export async function readRenderDefects(
  sessionId: string,
  root: string = sessionRoot(),
): Promise<RenderDefects> {
  let raw: string;
  try {
    raw = await readFile(diagnosticsPath(sessionId, root), "utf8");
  } catch {
    return { rendered: true, defects: [], verified: false };
  }

  let parsed: DiagnosticsFile;
  try {
    parsed = JSON.parse(raw) as DiagnosticsFile;
  } catch {
    return { rendered: true, defects: [], verified: false };
  }

  const defects: string[] = [];
  const design = parsed.design ?? {};
  const diagnostics = parsed.diagnostics ?? {};

  const unpainted = countOf(design.unpainted);
  const unreadable = countOf(design.unreadable);
  const collisions = countOf(design.collisions);
  const overflow = lengthOf(diagnostics.overflow);
  const skipped = lengthOf(diagnostics.skipped_objects);
  const truncations = lengthOf(diagnostics.truncations);

  if (unpainted > 0) {
    defects.push(`${unpainted} object${unpainted === 1 ? "" : "s"} painted no ink (invisible in the render)`);
  }
  if (unreadable > 0) {
    defects.push(`${unreadable} legibility failure${unreadable === 1 ? "" : "s"} (contrast or type size)`);
  }
  if (collisions > 0) {
    defects.push(`${collisions} text collision${collisions === 1 ? "" : "s"} (text painted over text)`);
  }
  if (overflow > 0) {
    defects.push(`${overflow} overflow signal${overflow === 1 ? "" : "s"} (content clipped or spilling)`);
  }
  if (skipped > 0) {
    defects.push(`${skipped} object${skipped === 1 ? "" : "s"} dropped by the renderer`);
  }
  if (truncations > 0) {
    defects.push(`${truncations} text truncation${truncations === 1 ? "" : "s"}`);
  }

  return { rendered: parsed.ok !== false, defects, verified: true };
}

/** Read an artifact's bytes, refusing anything the bridge could not send anyway. */
export async function readArtifact(artifact: Artifact): Promise<Uint8Array> {
  let size: number;
  try {
    size = (await stat(artifact.path)).size;
  } catch {
    throw new ArtifactError(
      `nothing at ${basename(artifact.path)} for session "${artifact.sessionId}" — the session may ` +
        "have been cleaned up, or the render wrote a different page. Render it again.",
    );
  }

  if (size === 0) throw new ArtifactError("that artifact is empty.");
  if (size > MAX_ARTIFACT_BYTES) {
    throw new ArtifactError(
      `that artifact is ${Math.round(size / (1024 * 1024))} MB, over the ${
        MAX_ARTIFACT_BYTES / (1024 * 1024)
      } MB attachment limit. Render fewer pages, or at a lower scale.`,
    );
  }

  return await readFile(artifact.path);
}
