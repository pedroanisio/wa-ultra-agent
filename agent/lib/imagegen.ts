/**
 * A sentence into a picture, and the picture into a file that waits to be sent.
 *
 * ── Why generating and sending are not one call ─────────────────────────────
 *
 * An image model is asked for a bicycle and returns something that is mostly a
 * bicycle. Text on a sign comes out as letter-shaped noise, a hand gains a
 * finger, the poster says HAPPY BIRTDHAY. None of that is an error the API
 * reports — the response is a 200 with an image in it, and the only way to know
 * is to look. So this module ends at a file on disk with an id, and a second
 * tool sends that id. The step in between is the model looking at what it made.
 *
 * ── What is verified here, and why each check exists ────────────────────────
 *
 * The bytes are sniffed rather than trusted. A 200 from this endpoint can carry
 * a URL instead of a payload (the `dall-e` default), an empty string, or an
 * error page from something in front of the API, and every one of those becomes
 * a broken attachment on somebody's phone if it is forwarded unread. A container
 * this code cannot name is refused before it can be stored.
 */

/** OpenAI's image endpoint. Overridable for a compatible provider. */
const ENDPOINT = process.env.WA_IMAGE_URL || "https://api.openai.com/v1/images/generations";

/**
 * `gpt-image-1` by default.
 *
 * It is the family that supports `output_format`, `output_compression` and
 * `background`, all three of which this module depends on to produce a file
 * that is small enough to look at and shaped like a photo. A `dall-e-*` model
 * set here still works, but ignores those fields and answers with a PNG.
 */
const MODEL = process.env.WA_IMAGE_MODEL || "gpt-image-1";

/**
 * The default quality, and it is deliberately not the highest.
 *
 * The destination is a phone screen inside a chat bubble. `high` costs several
 * times as much per image for detail that WhatsApp's own downscaling removes on
 * the way in. An operator who disagrees sets WA_IMAGE_QUALITY.
 */
const QUALITY = process.env.WA_IMAGE_QUALITY || "medium";

/**
 * The prompt ceiling.
 *
 * `gpt-image-1` accepts far more than this. The limit is editorial: a prompt
 * past a few thousand characters is a specification, and an image model does not
 * read one — it weights it, drops most of it, and returns something that ignores
 * the half the user cared about. Refusing is more honest than billing for that.
 */
export const MAX_PROMPT_CHARS = 4000;

/**
 * How hard the JPEG is compressed. High enough that the artefacts are invisible
 * at phone size, low enough that a generated image lands in the hundreds of
 * kilobytes rather than the megabytes a PNG of the same picture costs.
 */
const JPEG_COMPRESSION = 90;

/**
 * The shapes worth having, named for what they are for rather than by pixels.
 *
 * Only these three resolutions exist on `gpt-image-1`; asking for anything else
 * is a 400. Naming them removes the invitation to invent `800x600`.
 */
export const SIZES = {
  square: "1024x1024",
  portrait: "1024x1536",
  landscape: "1536x1024",
} as const;

export type SizeName = keyof typeof SIZES;

/** Typed, so a caller can tell a refusal from a network failure. */
export class ImageError extends Error {
  /** `config` | `refused` | `provider` | `decode` | `store`. */
  readonly kind: string;

  constructor(message: string, kind: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * The request that asks for an image.
 *
 * Split out so its shape can be asserted without a network: that one image is
 * asked for, that the format follows the background rather than being hoped for,
 * and that the key travels only in the header.
 */
export function imageRequest({
  prompt,
  key,
  size = "square",
  quality = QUALITY,
  background = "opaque",
  model = MODEL,
}: {
  prompt: string;
  key: string;
  size?: SizeName;
  quality?: string;
  background?: "opaque" | "transparent";
  model?: string;
}) {
  // Transparency and JPEG are mutually exclusive — JPEG has no alpha channel, so
  // a transparent background asked for as JPEG comes back composited onto black.
  // The format is therefore derived from the background rather than chosen
  // separately, which removes the combination that silently produces the wrong
  // picture.
  const transparent = background === "transparent";

  return {
    url: ENDPOINT,
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        // One image. `n` above 1 multiplies the bill and hands back a choice
        // nobody asked to make; a user who wants another one asks for another one.
        n: 1,
        size: SIZES[size] ?? SIZES.square,
        quality,
        ...(transparent
          ? { background: "transparent", output_format: "png" }
          : { output_format: "jpeg", output_compression: JPEG_COMPRESSION }),
      }),
    } satisfies RequestInit,
  };
}

/**
 * What the API actually complained about.
 *
 * OpenAI nests its message under `error.message`. Surfacing the JSON envelope
 * instead is how "your prompt was rejected by the safety system" reaches the
 * user as an unexplained failure they will retry three times.
 */
export function apiErrorMessage(status: number, body: string): string {
  try {
    const message = JSON.parse(body)?.error?.message;
    if (typeof message === "string" && message) return `${status}: ${message}`;
  } catch {
    // Not JSON — a proxy or a gateway answered. Fall through to the raw body.
  }
  return `${status}: ${body.slice(0, 200)}`;
}

/** The first bytes of every container this code is willing to send. */
const CONTAINERS: Array<{ mimetype: string; matches: (b: Buffer) => boolean }> = [
  { mimetype: "image/png", matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mimetype: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimetype: "image/webp", matches: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
];

/**
 * ⚠ ARCHITECTURAL CONTRACT (PALS's LAW) — LLM OUTPUT IS UNVERIFIED BY DEFAULT
 *
 * LLMs statistically produce errors: omissions, hallucinations,
 * partial completions, schema violations, and silent failures.
 * These are properties of the model class, not exceptional conditions.
 *
 * Any caller of this function that skips output validation is
 * introducing an architectural omission — not a code bug downstream.
 *
 * Verification is mandatory. Treat all LLM output as untrusted input.
 *
 * ── What this function verifies, and what it cannot ─────────────────────────
 *
 * It verifies the ENVELOPE: that there is a payload, that it decodes, and that
 * the bytes begin like an image file. It cannot verify the PICTURE — whether
 * the text in it is spelled correctly, whether it shows what was asked for,
 * whether it is embarrassing. That check has no code path; it is the model
 * looking at the image, which is why `whatsapp_generate_image` hands the picture
 * back rather than sending it.
 */
export function decodeImage(response: unknown): { bytes: Buffer; mimetype: string } {
  const first = (response as { data?: Array<{ b64_json?: string; url?: string }> })?.data?.[0];

  if (!first?.b64_json) {
    // A `url` here is not a near miss: it is the documented answer for the
    // `dall-e` models in their default mode, and the tell that WA_IMAGE_MODEL
    // points at one of them.
    throw new ImageError(
      first?.url
        ? "The API returned a link to the image rather than the image itself — no image data to send. " +
            "This provider needs response_format=b64_json, or a gpt-image model."
        : "The API answered without an image in it — there is no image to send.",
      "decode",
    );
  }

  const bytes = Buffer.from(first.b64_json, "base64");
  if (bytes.length === 0) throw new ImageError("The API returned an empty image — no image to send.", "decode");

  const container = CONTAINERS.find((candidate) => candidate.matches(bytes));
  if (!container) {
    throw new ImageError(
      `The API returned ${bytes.length} bytes that are not a PNG, JPEG or WebP file. Refusing to send ` +
        "them as a picture.",
      "decode",
    );
  }

  return { bytes, mimetype: container.mimetype };
}

/** Transient by nature: worth another go. Anything else is an answer. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface ImageDeps {
  fetch?: typeof globalThis.fetch;
  key?: string;
  /** Backoff between retries. Zero in tests so they do not sleep. */
  retryDelayMs?: number;
}

/**
 * Overridable defaults, for tests and for a compatible provider. Empty in normal
 * use, so the real network is what runs.
 */
export const imageDeps: ImageDeps = {};

export interface ImageInput {
  prompt: string;
  size?: SizeName;
  quality?: string;
  background?: "opaque" | "transparent";
}

export interface GeneratedImage {
  bytes: Buffer;
  mimetype: string;
  prompt: string;
  /** The resolution actually asked for, as the API spells it. */
  size: string;
  quality: string;
  model: string;
}

/**
 * Ask for an image. Returns the bytes, their real type, and what was asked for.
 *
 * See the contract on {@link decodeImage}: what comes back is verified as a
 * file and not as a picture.
 */
export async function generateImage(input: ImageInput, deps: ImageDeps = {}): Promise<GeneratedImage> {
  const fetchImpl = deps.fetch ?? imageDeps.fetch ?? globalThis.fetch;
  const key = deps.key ?? imageDeps.key ?? process.env.OPENAI_API_KEY ?? "";
  const delayMs = deps.retryDelayMs ?? imageDeps.retryDelayMs ?? 1000;

  const prompt = (input.prompt ?? "").trim();
  if (!prompt) throw new ImageError("There is nothing to draw: the prompt is empty.", "config");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new ImageError(
      `That prompt is ${prompt.length} characters and the ceiling is ${MAX_PROMPT_CHARS}. An image ` +
        "model weights a prompt rather than reading it, so past that length most of it is paid for and " +
        "ignored — say the picture in a paragraph.",
      "config",
    );
  }
  if (!key) {
    throw new ImageError(
      "OPENAI_API_KEY is not set on the agent, so no image can be generated. This is configuration, " +
        "not a network problem.",
      "config",
    );
  }

  const size = input.size ?? "square";
  const quality = input.quality ?? QUALITY;
  const request = imageRequest({ prompt, key, size, quality, background: input.background });

  let last = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetchImpl(request.url, request.init);

    if (response.ok) {
      const decoded = decodeImage(await response.json().catch(() => null));
      return { ...decoded, prompt, size: SIZES[size] ?? SIZES.square, quality, model: MODEL };
    }

    last = apiErrorMessage(response.status, await response.text().catch(() => ""));

    // A 400 is the safety system, a bad size, or an unknown model — all answers.
    // A 401 is the key. Retrying either turns a clear error into a slow one.
    if (!RETRYABLE.has(response.status) || attempt === 3) {
      throw new ImageError(
        `Image generation failed (${last})`,
        response.status === 401 || response.status === 403 ? "config" : response.status < 500 ? "refused" : "provider",
      );
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));
  }

  throw new ImageError(`Image generation failed (${last})`, "provider");
}

/* ------------------------------------------------------------------ *
 * Where an image waits between being made and being sent.
 *
 * On disk rather than in memory, because eve checkpoints a tool result as JSON
 * and a Map in this module does not survive the process being resumed — the
 * image would vanish between "look at this" and "send it", which is exactly the
 * gap the two-tool split creates.
 *
 * Scratch space, not an archive. The directory is container-local and
 * disappears with the container; an id that no longer resolves is a normal
 * outcome and the send tool says to generate the picture again rather than
 * apologising for a file the user never saw.
 * ------------------------------------------------------------------ */

/** Anything else is not an id this agent issued, and is not looked up. */
const ID = /^img-[a-z0-9]{6,32}$/;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

export function imageDir(): string {
  const configured = process.env.WA_IMAGE_DIR?.trim();
  if (configured) return configured;
  // Resolved lazily rather than at import: the tests point WA_IMAGE_DIR at a
  // fresh directory per case, and a constant captured at load time would ignore
  // every one of them.
  return `${process.env.TMPDIR?.replace(/\/$/, "") || "/tmp"}/wa-images`;
}

export interface StoredImage {
  id: string;
  bytes: Buffer;
  mimetype: string;
  prompt: string;
  size: string;
  createdAt: string;
}

/** Put a generated image where the send tool can find it, and name it. */
export async function storeImage(image: {
  bytes: Buffer;
  mimetype: string;
  prompt: string;
  size: string;
}): Promise<{ id: string; path: string }> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { randomBytes } = await import("node:crypto");
  const { join } = await import("node:path");

  const extension = EXTENSIONS[image.mimetype];
  if (!extension) throw new ImageError(`Refusing to store an image of unknown type ${image.mimetype}.`, "store");

  const dir = imageDir();
  const id = `img-${randomBytes(6).toString("hex")}`;
  const path = join(dir, `${id}.${extension}`);

  await mkdir(dir, { recursive: true });
  await writeFile(path, image.bytes);
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      mimetype: image.mimetype,
      prompt: image.prompt,
      size: image.size,
      file: `${id}.${extension}`,
      createdAt: new Date().toISOString(),
    }),
  );

  return { id, path };
}

/**
 * Read a stored image back.
 *
 * The id is matched against a pattern before it becomes a path. It arrives from
 * a model, which means it can arrive as `../../etc/passwd` — and the failure
 * mode of getting that wrong is not a crash but a successful send of whatever
 * the path happened to name.
 */
export async function loadImage(id: string): Promise<StoredImage> {
  const missing = () =>
    new ImageError(
      `There is no image with the id ${JSON.stringify(id)}. Generated images are scratch space and do ` +
        "not outlive the agent — generate it again rather than sending something else.",
      "store",
    );

  if (!ID.test((id ?? "").trim())) throw missing();

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = imageDir();

  let meta: { mimetype?: string; prompt?: string; size?: string; file?: string; createdAt?: string };
  try {
    meta = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"));
  } catch {
    throw missing();
  }

  const file = meta.file;
  // The sidecar is written by this module, but it is still a filename read off
  // disk and turned into a path. It gets the same treatment as the id.
  if (!file || !file.startsWith(`${id}.`) || file.includes("/")) throw missing();

  try {
    return {
      id,
      bytes: await readFile(join(dir, file)),
      mimetype: meta.mimetype ?? "image/png",
      prompt: meta.prompt ?? "",
      size: meta.size ?? "",
      createdAt: meta.createdAt ?? "",
    };
  } catch {
    throw missing();
  }
}
