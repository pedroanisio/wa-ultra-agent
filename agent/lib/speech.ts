/**
 * Text into a WhatsApp voice note.
 *
 * ── Why this is three steps and not one ─────────────────────────────────────
 *
 * A voice note is not "some audio". WhatsApp renders exactly one thing as a
 * voice note — Opus in an OGG container, sent as PTT with a duration — and
 * anything else arrives as an attachment with a paperclip, which is a different
 * message to receive. So:
 *
 *   1. OpenAI synthesises speech, in whatever format it is asked for.
 *   2. ffmpeg re-encodes it to Opus/OGG, mono, 48 kHz.
 *   3. ffprobe measures the RESULT, and that measurement is what is sent.
 *
 * Step 3 measures the encoded file rather than the input on purpose. The
 * duration is what the bubble displays and what the waveform is drawn against,
 * and an encode can change the length; a figure carried over from the input is a
 * claim about a file that no longer exists.
 *
 * ── Why the network and the binary are injected ─────────────────────────────
 *
 * So that every rule above is testable without an API key, without ffmpeg, and
 * without making a sound. The defaults are the real ones.
 */

/** What the transport must be told, and what WhatsApp will render. */
export const VOICE_MIMETYPE = "audio/ogg; codecs=opus";

/**
 * The ceiling on one voice note, and it is now an EDITORIAL one.
 *
 * It used to be the API's per-request limit. Chunking removed that constraint —
 * anything longer is split at sentence boundaries and stitched — so what is left
 * is a judgement about the medium: roughly ten thousand characters is ten
 * minutes of someone talking at you in a chat window, which is past the point
 * where the honest answer is a text message.
 *
 * Kept because the failure it prevents is expensive in both directions: the API
 * bills per character, and the recipient pays in attention.
 */
export const MAX_SPEECH_CHARS = 10_000;

/** OpenAI's speech endpoint. Overridable for a compatible provider. */
const ENDPOINT = process.env.WA_SPEECH_URL || "https://api.openai.com/v1/audio/speech";
const MODEL = process.env.WA_SPEECH_MODEL || "gpt-4o-mini-tts";

/* ------------------------------------------------------------------ *
 * ElevenLabs
 *
 * A second provider, for one reason: it sounds like a person and OpenAI's
 * voices sound like a narrator. Everything downstream is unchanged — the
 * container, the duration and the PTT flag are produced here regardless of who
 * spoke, so switching provider cannot change what WhatsApp receives.
 * ------------------------------------------------------------------ */

const ELEVEN_ENDPOINT = process.env.WA_ELEVENLABS_URL || "https://api.elevenlabs.io/v1/text-to-speech";

/**
 * `eleven_multilingual_v2` by default, and that default is load-bearing.
 *
 * Half of this account's correspondence is Portuguese. An English-only model
 * does not refuse Portuguese — it reads it with an English mouth, which is worse
 * than refusing, because it ships.
 */
const ELEVEN_MODEL = process.env.WA_ELEVENLABS_MODEL || "eleven_multilingual_v2";

/**
 * The per-request character ceiling, conservative enough for every model.
 *
 * Borrowed, with the reasoning, from `super-tools/tools/eleven-tts`: the API
 * bills and limits per character, and a request that trips the limit fails
 * whole. Splitting below it is cheaper than discovering the boundary.
 */
export const CHUNK_CHARS = 4500;

/** Anything this shape is already an id and needs no lookup. */
const VOICE_ID_RE = /^[A-Za-z0-9]{20,32}$/;

/**
 * Whether a voice was given as an id rather than a name.
 *
 * Worth the check for a second reason beyond saving a round trip: listing
 * voices needs the `voices_read` permission, and a key without it can still
 * speak. An id must therefore never require a lookup to be usable.
 */
export function looksLikeVoiceId(value: string): boolean {
  return VOICE_ID_RE.test((value || "").trim());
}

/**
 * Find the voice someone meant, by exact name then by unique prefix.
 *
 * Ambiguity is refused rather than resolved. This is the same rule
 * `recipients.js` applies to people and for the same reason: picking one of two
 * matches is a coin flip over whose voice speaks in the user's name, and the
 * cost of asking is a single retry with a longer name.
 */
export function pickVoice(
  voices: Array<{ voice_id?: string; name?: string }>,
  want: string,
): string {
  const wanted = (want || "").trim().toLowerCase();
  const named = (v: { name?: string }) => String(v.name ?? "").toLowerCase();

  let matches = voices.filter((v) => named(v) === wanted);
  if (matches.length === 0) matches = voices.filter((v) => named(v).startsWith(wanted));

  if (matches.length === 1) return String(matches[0].voice_id);
  if (matches.length === 0) {
    throw new Error(
      `No ElevenLabs voice matches ${JSON.stringify(want)}. ` +
        `This account has: ${voices.map((v) => v.name).filter(Boolean).join(", ") || "none"}.`,
    );
  }
  throw new Error(
    `The voice ${JSON.stringify(want)} is ambiguous — it matches ` +
      `${matches.map((v) => v.name).join(", ")}. Name it fully.`,
  );
}

/** Sentence and paragraph boundaries, in that order of preference. */
const SENTENCE_SPLIT = /(?<=[.!?…])\s+|\n{2,}/;

/**
 * Split text into pieces no longer than `limit`, at sentence boundaries.
 *
 * A hard split inside a word is audible — the model pronounces the fragment as
 * written — so an over-long single sentence is broken at a space instead, and
 * only at a character position if it has no spaces at all.
 */
export function chunkText(text: string, limit: number = CHUNK_CHARS): string[] {
  const body = (text ?? "").trim();
  if (!body) return [];
  if (body.length <= limit) return [body];

  const chunks: string[] = [];
  let current = "";

  for (let part of body.split(SENTENCE_SPLIT)) {
    part = part.split(/\s+/).join(" ").trim();
    if (!part) continue;

    while (part.length > limit) {
      const space = part.lastIndexOf(" ", limit);
      const cut = space > 0 ? space : limit;
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(part.slice(0, cut).trim());
      part = part.slice(cut).trim();
    }
    if (!part) continue;

    if (current && current.length + 1 + part.length > limit) {
      chunks.push(current);
      current = part;
    } else {
      current = current ? `${current} ${part}` : part;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * What the API actually complained about.
 *
 * ElevenLabs nests its message under `detail`, sometimes as an object and
 * sometimes as a string. Surfacing 300 characters of JSON envelope instead is
 * how "quota exceeded" reads as an unexplained failure.
 */
export function apiErrorMessage(status: number, body: string): string {
  try {
    const detail = JSON.parse(body)?.detail;
    if (typeof detail === "string") return `${status}: ${detail}`;
    if (detail && typeof detail === "object") {
      return `${status}: ${detail.message || detail.status || body.slice(0, 200)}`;
    }
  } catch {
    // Not JSON. Fall through to the raw body, truncated.
  }
  return `${status}: ${body.slice(0, 200)}`;
}

/** Transient by nature: worth another go. Anything else is an answer. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * The names an ElevenLabs key travels under.
 *
 * Three spellings are in circulation and all three are in real use — the key on
 * the machine this was built against was `ELEVEN_LABS_API_KEY`, while this file
 * originally read only `ELEVENLABS_API_KEY`, so "is a provider configured?"
 * answered no while the key sat in `.env`. Honouring one spelling is not a
 * safeguard, it is a puzzle.
 */
export const ELEVENLABS_KEY_NAMES = [
  "ELEVENLABS_API_KEY",
  "ELEVEN_LABS_API_KEY",
  "XI_API_KEY",
] as const;

/** The first non-empty ElevenLabs key in the environment, or `""`. */
export function elevenLabsKey(env: Record<string, string | undefined> = process.env): string {
  for (const name of ELEVENLABS_KEY_NAMES) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

/** Which service is asked to speak. */
export type SpeechProvider = "openai" | "elevenlabs";

/**
 * Who answers, decided from configuration alone.
 *
 * ElevenLabs wins when both keys are present, because an operator who has
 * configured it has said what they want. `null` means neither is configured,
 * which is a fact worth returning rather than a default worth guessing — the
 * caller can then name the missing variable instead of failing at an HTTP 401.
 */
export function chooseProvider(env: Record<string, string | undefined> = process.env): SpeechProvider | null {
  const explicit = (env.WA_SPEECH_PROVIDER || "").trim().toLowerCase();
  if (explicit === "openai" || explicit === "elevenlabs") return explicit;

  if (elevenLabsKey(env)) return "elevenlabs";
  if (env.OPENAI_API_KEY?.trim()) return "openai";
  return null;
}

/**
 * The ElevenLabs request.
 *
 * Two differences from OpenAI, both structural: the key is its own header rather
 * than a bearer token, and the voice is part of the URL rather than a field.
 *
 * ── Why it asks for mp3 when Opus is on the menu ────────────────────────────
 * ElevenLabs offers `opus_48000_32`, which is the bitrate and rate this pipeline
 * wants. Its documentation does not say which CONTAINER that arrives in, and
 * WhatsApp renders a waveform for exactly one — OGG. Rather than depend on an
 * undocumented detail that would fail as "the voice note arrived as a file",
 * the audio is normalised by ffmpeg either way. The transcode already exists for
 * OpenAI; reusing it costs a second of CPU and removes a guess.
 */
export function elevenLabsRequest({
  text,
  voice,
  key,
  model = ELEVEN_MODEL,
  previousText,
  nextText,
}: {
  text: string;
  voice: string;
  key: string;
  model?: string;
  previousText?: string;
  nextText?: string;
}) {
  const voiceId = (voice || "").trim();
  if (!voiceId) {
    throw new Error(
      "No ElevenLabs voice was chosen. Set WA_ELEVENLABS_VOICE_ID to the id of a voice on your " +
        "account — GET https://api.elevenlabs.io/v1/voices lists them with their ids.",
    );
  }

  return {
    url: `${ELEVEN_ENDPOINT}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    init: {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: model,
        ...(previousText ? { previous_text: previousText } : {}),
        ...(nextText ? { next_text: nextText } : {}),
        // Their defaults, stated rather than inherited: a provider changing a
        // default underneath us would change how the user sounds without a
        // single line of this repository changing.
        voice_settings: { stability: 0.5, similarity_boost: 0.75, use_speaker_boost: true },
      }),
    } satisfies RequestInit,
  };
}

/** One shelled-out command. Injected so tests need no binaries. */
export type Runner = (
  cmd: string,
  args: string[],
  input?: Buffer,
) => Promise<{ stdout: Buffer; stderr: string; code: number }>;

/**
 * Overridable defaults, for tests and for a compatible provider.
 *
 * `speak` takes its dependencies per call, but the tool that uses it has no
 * business threading fakes through its own signature — a production tool should
 * not have a test-only parameter. This is the seam instead: empty in normal use,
 * so the real network and the real binary are what run.
 */
export const speechDeps: SpeechDeps = {};

export interface SpeechDeps {
  fetch?: typeof globalThis.fetch;
  run?: Runner;
  key?: string;
  /** Overrides what configuration would have chosen. Mostly for tests. */
  provider?: SpeechProvider;
  /** Backoff between retries. Zero in tests so they do not sleep. */
  retryDelayMs?: number;
}

export interface SpeechInput {
  text: string;
  /**
   * A voice NAME, a unique prefix of one, or a raw ElevenLabs id. Not the
   * user's own voice — see the tool's warning.
   */
  voice?: string;
  /** Overrides the configured model. `eleven_v3` changes chunking behaviour. */
  model?: string;
}

/**
 * The HTTP request that asks for speech.
 *
 * Split out so the shape can be asserted without a network: that a model is
 * named rather than defaulted, that a format is asked for explicitly, and that
 * the key travels only in the header.
 */
export function ttsRequest({ text, voice, key }: { text: string; voice: string; key: string }) {
  return {
    url: ENDPOINT,
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        voice,
        input: text,
        // mp3 in, Opus out. Asking OpenAI for `opus` would return raw Opus
        // frames rather than the OGG container WhatsApp needs, so the transcode
        // below is not optional and the input format may as well be the safe one.
        response_format: "mp3",
      }),
    } satisfies RequestInit,
  };
}

/**
 * The encode. Every flag here is load-bearing:
 *
 * - `libopus` + `-f ogg` is the only combination WhatsApp draws a waveform for.
 * - `-ac 1` because a voice note is one person talking; stereo doubles the bytes
 *   to carry the same thing twice.
 * - `-ar 48000` is Opus's native rate — anything else is resampled anyway.
 * - `-b:a 32k` is comfortably enough for speech and keeps the upload small.
 */
export function encodeArgs(): string[] {
  return [
    "-hide_banner", "-loglevel", "error",
    "-i", "pipe:0",
    "-c:a", "libopus",
    "-b:a", "32k",
    "-ar", "48000",
    "-ac", "1",
    "-f", "ogg",
    "pipe:1",
  ];
}

/** What ffprobe is asked, so it answers with a bare number and nothing else. */
export function probeArgs(path: string): string[] {
  return [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ];
}

/**
 * ffprobe's answer, as the whole seconds WhatsApp wants.
 *
 * Rounded UP, and never below one. Rounding down claims a 3.9-second note is
 * three seconds and leaves the waveform short of the audio; zero renders as a
 * bubble that looks broken before it is even played.
 */
export function parseDurationSeconds(stdout: string): number {
  const value = Number.parseFloat(String(stdout).trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Could not read the duration of the encoded audio (ffprobe said ${JSON.stringify(String(stdout).trim())}). ` +
        "Refusing to send a voice note with a made-up length.",
    );
  }
  return Math.max(1, Math.ceil(value));
}

/**
 * One HTTP call, retried while the failure looks transient.
 *
 * Three attempts with 2s/4s backoff. A 401 or a 402 is an ANSWER — the key is
 * wrong, or the credits are gone — and retrying it only turns a clear error into
 * a slow one.
 */
async function requestWithRetry(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  who: string,
  delayMs: number,
): Promise<Buffer> {
  let last = "";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetchImpl(url, init);
    if (response.ok) return Buffer.from(await response.arrayBuffer());

    const body = await response.text().catch(() => "");
    last = apiErrorMessage(response.status, body);

    if (!RETRYABLE.has(response.status) || attempt === 3) {
      throw new Error(`${who} speech synthesis failed (${last})`);
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));
  }

  throw new Error(`${who} speech synthesis failed (${last})`);
}

/** The real runner: spawn, collect, never shell-interpolate. */
const spawnRunner: Runner = async (cmd, args, input) => {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    const stdout: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) =>
      reject(
        new Error(
          `${cmd} could not be started (${error.message}). It must be installed in this image — ` +
            "see the Dockerfile.",
        ),
      ),
    );
    child.on("close", (code) => resolve({ stdout: Buffer.concat(stdout), stderr, code: code ?? 0 }));

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
};

/**
 * Say something, as a file WhatsApp will render as a voice note.
 *
 * Returns the bytes, their mimetype, and the duration measured from the bytes
 * themselves — the three things `/send/media` needs to produce a PTT message.
 */
export async function speak(
  { text, voice, model: modelId }: SpeechInput,
  deps: SpeechDeps = {},
): Promise<{ audio: Buffer; mimetype: string; seconds: number }> {
  const fetchImpl = deps.fetch ?? speechDeps.fetch ?? globalThis.fetch;
  const run = deps.run ?? speechDeps.run ?? spawnRunner;
  const provider = deps.provider ?? speechDeps.provider ?? chooseProvider();
  const key =
    deps.key ??
    speechDeps.key ??
    (provider === "elevenlabs" ? elevenLabsKey() : process.env.OPENAI_API_KEY) ??
    "";

  // A named voice on one service is an opaque id on the other, so the default
  // has to be chosen after the provider is known.
  voice =
    voice ||
    (provider === "elevenlabs"
      ? process.env.WA_ELEVENLABS_VOICE_ID || process.env.WA_ELEVENLABS_VOICE || ""
      : process.env.WA_SPEECH_VOICE || "alloy");

  const body = (text ?? "").trim();
  if (!body) throw new Error("There is nothing to say: the text is empty.");
  if (body.length > MAX_SPEECH_CHARS) {
    throw new Error(
      `That is ${body.length} characters and the ceiling is ${MAX_SPEECH_CHARS} — around ten minutes ` +
        "of speech. Nothing technical stops it, but a voice note that long is the wrong medium: " +
        "send it as text.",
    );
  }
  if (!provider) {
    throw new Error(
      `No speech provider is configured, so nothing can be synthesised. Set one of ` +
        `${ELEVENLABS_KEY_NAMES.join(" / ")} (for the realistic voices) or OPENAI_API_KEY. ` +
        "This is configuration, not a network problem.",
    );
  }
  if (!key) {
    const name =
      provider === "elevenlabs" ? ELEVENLABS_KEY_NAMES.join(" / ") : "OPENAI_API_KEY";
    throw new Error(
      `${name} is not set on the agent, so speech cannot be synthesised. This is configuration, ` +
        "not a network problem.",
    );
  }

  const who = provider === "elevenlabs" ? "ElevenLabs" : "OpenAI";
  const delayMs = deps.retryDelayMs ?? speechDeps.retryDelayMs ?? 1000;

  let spoken: Buffer;

  if (provider === "elevenlabs") {
    // A name is resolved against the account; an id is used as given, because
    // the lookup needs a permission the key may not carry.
    const voiceId = looksLikeVoiceId(voice)
      ? voice
      : pickVoice(
          JSON.parse(
            String(
              await requestWithRetry(
                fetchImpl,
                `${ELEVEN_ENDPOINT.replace("/text-to-speech", "")}/voices`,
                { method: "GET", headers: { "xi-api-key": key } },
                who,
                delayMs,
              ),
            ),
          ).voices ?? [],
          voice,
        );

    // Longer than one request allows: split at sentences, and tell each chunk
    // what surrounds it so the delivery does not restart at every seam.
    const model = modelId ?? ELEVEN_MODEL;
    const chunks = chunkText(body);
    // eleven_v3 rejects previous_text/next_text outright, so that family is
    // stitched without cross-request context rather than failing.
    const withContext = !model.startsWith("eleven_v3");

    const parts: Buffer[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const request = elevenLabsRequest({
        text: chunk,
        voice: voiceId,
        key,
        model,
        previousText: withContext && index > 0 ? chunks[index - 1] : undefined,
        nextText: withContext && index < chunks.length - 1 ? chunks[index + 1] : undefined,
      });
      parts.push(await requestWithRetry(fetchImpl, request.url, request.init, who, delayMs));
    }
    // mp3 frames concatenate; ffmpeg re-encodes the whole thing below anyway.
    spoken = Buffer.concat(parts);
  } else {
    const request = ttsRequest({ text: body, voice, key });
    spoken = await requestWithRetry(fetchImpl, request.url, request.init, who, delayMs);
  }

  const encoded = await run("ffmpeg", encodeArgs(), spoken);
  if (encoded.code !== 0 || encoded.stdout.length === 0) {
    throw new Error(`Encoding to Opus failed: ${encoded.stderr.trim() || `ffmpeg exited ${encoded.code}`}`);
  }

  // ffprobe cannot seek a pipe reliably, and a duration is exactly the thing a
  // partial read gets wrong — so the encoded bytes go to a real file first.
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const dir = await mkdtemp(join(tmpdir(), "wa-voice-"));
  const file = join(dir, "note.ogg");
  try {
    await writeFile(file, encoded.stdout);
    const probed = await run("ffprobe", probeArgs(file));
    if (probed.code !== 0) {
      throw new Error(`Could not measure the audio: ${probed.stderr.trim() || `ffprobe exited ${probed.code}`}`);
    }
    return {
      audio: encoded.stdout,
      mimetype: VOICE_MIMETYPE,
      seconds: parseDurationSeconds(String(probed.stdout)),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
