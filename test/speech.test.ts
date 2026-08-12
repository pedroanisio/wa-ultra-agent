import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SPEECH_CHARS,
  VOICE_MIMETYPE,
  chooseProvider,
  chunkText,
  elevenLabsKey,
  elevenLabsRequest,
  looksLikeVoiceId,
  pickVoice,
  encodeArgs,
  parseDurationSeconds,
  speak,
  ttsRequest,
} from "../agent/lib/speech.ts";

/**
 * Turning text into a WhatsApp voice note.
 *
 * Three things here are not interchangeable and each one has cost a real bug in
 * some system somewhere: the container (WhatsApp renders only OGG/Opus), the
 * PTT flag (the difference between a voice note and an attached file), and the
 * duration (what the bubble displays and the waveform is drawn against).
 *
 * The network and ffmpeg are injected so all of that is testable without an API
 * key, without a binary, and without making a sound.
 */

/** A fake `fetch` that returns synthetic mp3 bytes and records the request. */
function fakeOpenAI(bytes = Buffer.from("ID3-fake-mp3")) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(bytes, { status: 200, headers: { "content-type": "audio/mpeg" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** A fake ffmpeg/ffprobe. Returns ogg bytes for encode, a duration for probe. */
function fakeRunner(seconds = "3.456") {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (cmd === "ffprobe") return { stdout: Buffer.from(`${seconds}\n`), stderr: "", code: 0 };
    return { stdout: Buffer.from("OggS-fake"), stderr: "", code: 0 };
  };
  return { calls, run };
}

/* ── the request to OpenAI ─────────────────────────────────────────── */

test("the TTS request names a model, a voice and a format", () => {
  const request = ttsRequest({ text: "olá", voice: "alloy", key: "sk-test" });

  assert.match(request.url, /openai\.com/);
  assert.equal(request.init.method, "POST");
  assert.match(String((request.init.headers as Record<string, string>).authorization), /^Bearer sk-test$/);

  const body = JSON.parse(String(request.init.body));
  assert.equal(body.input, "olá");
  assert.equal(body.voice, "alloy");
  assert.ok(body.model, "a model must be named, never left to the default");
  assert.ok(body.response_format, "the audio format must be asked for explicitly");
});

test("the key never travels in the URL or the body", () => {
  const request = ttsRequest({ text: "olá", voice: "alloy", key: "sk-secret" });
  assert.doesNotMatch(request.url, /sk-secret/);
  assert.doesNotMatch(String(request.init.body), /sk-secret/);
});

/* ── what ffmpeg is asked for ──────────────────────────────────────── */

test("the encode targets exactly what WhatsApp renders", () => {
  const args = encodeArgs();
  const line = args.join(" ");

  // Any one of these missing produces a file that either will not play or
  // arrives as an attachment instead of a voice note.
  assert.match(line, /libopus/, "Opus, not mp3");
  assert.match(line, /-f ogg/, "in an OGG container");
  assert.match(line, /-ac 1/, "mono — a voice note is not stereo");
  assert.match(line, /-ar 48000/, "48 kHz, which is Opus's native rate");
});

/* ── duration, which the bubble displays ───────────────────────────── */

test("a fractional duration rounds up to a whole second", () => {
  // Rounding down would claim a 3.9-second note is 3 seconds and leave the
  // waveform short of the audio.
  assert.equal(parseDurationSeconds("3.456\n"), 4);
  assert.equal(parseDurationSeconds("3.0\n"), 3);
});

test("a very short clip is still at least one second", () => {
  assert.equal(parseDurationSeconds("0.2\n"), 1, "zero seconds renders as a broken bubble");
});

test("an unreadable duration is refused rather than guessed", () => {
  for (const bad of ["", "N/A\n", "not-a-number"]) {
    assert.throws(() => parseDurationSeconds(bad), /duration/i, `${JSON.stringify(bad)} must throw`);
  }
});

/* ── the whole path ────────────────────────────────────────────────── */

test("speak returns OGG bytes and the duration measured from them", async () => {
  const openai = fakeOpenAI();
  const ffmpeg = fakeRunner("2.4");

  const result = await speak(
    { text: "oi, tudo bem?", voice: "alloy" },
    { fetch: openai.fetchImpl, run: ffmpeg.run, key: "sk-test" },
  );

  assert.equal(result.mimetype, VOICE_MIMETYPE);
  assert.equal(result.seconds, 3, "2.4s of audio is a 3-second bubble");
  assert.ok(result.audio.length > 0);

  assert.equal(openai.calls.length, 1, "one synthesis");
  assert.deepEqual(
    ffmpeg.calls.map((c) => c.cmd),
    ["ffmpeg", "ffprobe"],
    "encode, then measure the ENCODED file — not the input",
  );
});

test("an empty or blank line is refused before any of it happens", async () => {
  const openai = fakeOpenAI();
  const ffmpeg = fakeRunner();

  await assert.rejects(
    speak({ text: "   ", voice: "alloy" }, { fetch: openai.fetchImpl, run: ffmpeg.run, key: "sk-test" }),
    /nothing to say/i,
  );
  assert.equal(openai.calls.length, 0, "no request is made for silence");
});

test("text longer than the model accepts is refused with the limit named", async () => {
  const openai = fakeOpenAI();
  const ffmpeg = fakeRunner();

  await assert.rejects(
    speak(
      { text: "a".repeat(MAX_SPEECH_CHARS + 1), voice: "alloy" },
      { fetch: openai.fetchImpl, run: ffmpeg.run, key: "sk-test" },
    ),
    new RegExp(String(MAX_SPEECH_CHARS)),
  );
  assert.equal(openai.calls.length, 0);
});

test("a missing key is named as the missing thing, not reported as a network fault", async () => {
  const openai = fakeOpenAI();
  const ffmpeg = fakeRunner();

  await assert.rejects(
    speak({ text: "oi", voice: "alloy" }, { fetch: openai.fetchImpl, run: ffmpeg.run, key: "" }),
    /OPENAI_API_KEY/,
  );
  assert.equal(openai.calls.length, 0);
});

test("OpenAI refusing is reported with its status, not swallowed", async () => {
  const failing = (async () =>
    new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 })) as typeof fetch;

  await assert.rejects(
    speak({ text: "oi", voice: "alloy" }, { fetch: failing, run: fakeRunner().run, key: "sk-test" }),
    /429/,
  );
});

test("ffmpeg failing is reported with what it said", async () => {
  const openai = fakeOpenAI();
  const broken = async (cmd: string) => ({
    stdout: Buffer.alloc(0),
    stderr: cmd === "ffmpeg" ? "Unknown encoder 'libopus'" : "",
    code: 1,
  });

  await assert.rejects(
    speak({ text: "oi", voice: "alloy" }, { fetch: openai.fetchImpl, run: broken, key: "sk-test" }),
    /libopus/,
  );
});

/* ── which route a voice note takes ────────────────────────────────── */

process.env.WA_BRIDGE_TOKEN ??= "test-token";
process.env.WA_BRIDGE_URL ??= "http://bridge.test";
process.env.OPENAI_API_KEY ??= "sk-test";

const voiceTool = (await import("../agent/tools/whatsapp_send_voice.ts")).default;
const { speechDeps } = await import("../agent/lib/speech.ts");

// The tool runs the real ffmpeg, which quite correctly refuses invented mp3
// bytes. Point the encoder at a fake for these three tests; what is under test
// here is which ROUTE a voice note takes, not the codec.
speechDeps.run = fakeRunner("2.0").run;

/** Capture the bridge request, and answer OpenAI with fake mp3 bytes. */
function captureSend() {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname.endsWith("openai.com")) {
      return new Response(Buffer.from("ID3-fake"), { status: 200 });
    }
    calls.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify({ id: "3EB0" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { calls, restore: () => void (globalThis.fetch = original) };
}

test("a voice note to a person goes to /send/media as kind voice", async () => {
  const fake = captureSend();
  try {
    const result = await voiceTool.execute({ to: "Tuca", text: "oi" }, {} as never);

    assert.equal(result.ok, true);
    assert.equal(fake.calls[0].path, "/send/media");
    assert.equal(fake.calls[0].body.kind, "voice", "audio would arrive as a file, not a voice note");
    assert.match(String(fake.calls[0].body.mimetype), /ogg.*opus/);
    assert.ok(Number(fake.calls[0].body.durationSeconds) >= 1, "a duration is always declared");
  } finally {
    fake.restore();
  }
});

test("with no recipient it goes to the user's own chat instead", async () => {
  // `/send/media` resolves a NAME against the roster, and the account itself is
  // not in it — addressing the self chat that way answers 404. This is the bug
  // that only showed up against the live bridge.
  const fake = captureSend();
  try {
    const result = await voiceTool.execute({ text: "oi" }, {} as never);

    assert.equal(result.ok, true);
    assert.equal(fake.calls[0].path, "/send/self/media");
    assert.equal(fake.calls[0].body.kind, "voice");
    assert.equal(fake.calls[0].body.to, undefined, "the self route takes no recipient at all");
  } finally {
    fake.restore();
  }
});

test("when synthesis fails nothing is sent, and it says which half broke", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.hostname.endsWith("openai.com")) return new Response("nope", { status: 500 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const result = await voiceTool.execute({ to: "Tuca", text: "oi" }, {} as never);
    assert.equal(result.ok, false);
    assert.equal(result.stage, "synthesis");
    assert.equal(calls.filter((p) => p.startsWith("/send")).length, 0, "WhatsApp was never touched");
  } finally {
    globalThis.fetch = original;
  }
});


/* ── ElevenLabs ────────────────────────────────────────────────────────
 *
 * A second provider, not a replacement. What matters in these tests is that
 * its two genuine differences from OpenAI are honoured — the key travels in
 * `xi-api-key` rather than a bearer header, and the voice is part of the URL
 * rather than the body — and that everything downstream is unchanged, because
 * the container WhatsApp needs is produced by ffmpeg either way.
 * ------------------------------------------------------------------ */

test("the ElevenLabs request puts the voice in the path and the key in its own header", () => {
  const request = elevenLabsRequest({ text: "olá", voice: "voice-123", key: "xi-secret" });

  assert.match(request.url, /api\.elevenlabs\.io\/v1\/text-to-speech\/voice-123/);
  assert.equal(request.init.method, "POST");

  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers["xi-api-key"], "xi-secret");
  assert.equal(headers.authorization, undefined, "ElevenLabs does not use a bearer token");
});

test("it asks for a multilingual model, because half this account is Portuguese", () => {
  const body = JSON.parse(String(elevenLabsRequest({ text: "olá", voice: "v", key: "k" }).init.body));
  assert.match(body.model_id, /multilingual|v3/, `${body.model_id} must handle more than English`);
  assert.equal(body.text, "olá");
});

test("the ElevenLabs key never travels in the URL or the body", () => {
  const request = elevenLabsRequest({ text: "olá", voice: "v", key: "xi-secret" });
  assert.doesNotMatch(request.url, /xi-secret/);
  assert.doesNotMatch(String(request.init.body), /xi-secret/);
});

test("a voice id is required, and its absence names the variable to set", () => {
  assert.throws(
    () => elevenLabsRequest({ text: "olá", voice: "", key: "k" }),
    /WA_ELEVENLABS_VOICE_ID/,
  );
});

/* ── which provider answers ────────────────────────────────────────── */

test("ElevenLabs is used when its key is present", () => {
  assert.equal(chooseProvider({ ELEVENLABS_API_KEY: "xi", OPENAI_API_KEY: "sk" }), "elevenlabs");
});

test("OpenAI is the fallback when only its key is present", () => {
  assert.equal(chooseProvider({ OPENAI_API_KEY: "sk" }), "openai");
});

test("an explicit choice beats whichever keys happen to be set", () => {
  assert.equal(
    chooseProvider({ WA_SPEECH_PROVIDER: "openai", ELEVENLABS_API_KEY: "xi", OPENAI_API_KEY: "sk" }),
    "openai",
  );
});

test("no keys at all is reported as a configuration answer, not a guess", () => {
  assert.equal(chooseProvider({}), null);
});

test("speak uses ElevenLabs end to end when configured, and still transcodes", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers["xi-api-key"], "xi-test", "the key must reach ElevenLabs");
    return new Response(Buffer.from("ID3-fake"), { status: 200 });
  }) as typeof fetch;

  const ffmpeg = fakeRunner("6.1");
  const result = await speak(
    { text: "um causo", voice: "21m00Tcm4TlvDq8ikWAM" },
    { fetch: fetchImpl, run: ffmpeg.run, key: "xi-test", provider: "elevenlabs" },
  );

  assert.match(calls[0], /elevenlabs\.io/);
  assert.equal(result.mimetype, VOICE_MIMETYPE, "still OGG/Opus, whoever spoke it");
  assert.equal(result.seconds, 7);
  assert.deepEqual(ffmpeg.calls.map((c) => c.cmd), ["ffmpeg", "ffprobe"]);
});

test("an ElevenLabs refusal names ElevenLabs, not a generic failure", async () => {
  const failing = (async () =>
    new Response(JSON.stringify({ detail: { status: "invalid_api_key" } }), { status: 401 })) as typeof fetch;

  await assert.rejects(
    speak(
      { text: "oi", voice: "v" },
      { fetch: failing, run: fakeRunner().run, key: "xi-bad", provider: "elevenlabs" },
    ),
    /401/,
  );
});

/* ── borrowed from super-tools/eleven-tts ──────────────────────────────
 *
 * Four things that implementation got right and this one did not: a voice can
 * be named rather than looked up as an opaque id, a transient API failure is
 * retried, an error says what the API actually complained about, and text too
 * long for one request is split at sentence boundaries with context carried
 * across the seam so the delivery does not lurch.
 * ------------------------------------------------------------------ */

test("a voice is found by exact name, case-insensitively", () => {
  const voices = [
    { voice_id: "id-rachel", name: "Rachel" },
    { voice_id: "id-antoni", name: "Antoni" },
  ];
  assert.equal(pickVoice(voices, "rachel"), "id-rachel");
});

test("a unique prefix is enough", () => {
  const voices = [
    { voice_id: "id-rachel", name: "Rachel" },
    { voice_id: "id-antoni", name: "Antoni" },
  ];
  assert.equal(pickVoice(voices, "rach"), "id-rachel");
});

test("an ambiguous prefix is refused, with the candidates named", () => {
  const voices = [
    { voice_id: "a", name: "Maria" },
    { voice_id: "b", name: "Mariana" },
  ];
  // Picking either would be a coin flip over whose voice speaks in the user's
  // name — the same class of mistake the recipient resolver refuses.
  assert.throws(() => pickVoice(voices, "mari"), /Maria.*Mariana|ambiguous/i);
});

test("a name that matches nothing says so rather than falling back", () => {
  assert.throws(() => pickVoice([{ voice_id: "a", name: "Maria" }], "Bob"), /Bob/);
});

test("something already shaped like an id is used as-is", () => {
  // Also the only path that works when the key lacks `voices_read`.
  assert.equal(looksLikeVoiceId("21m00Tcm4TlvDq8ikWAM"), true);
  assert.equal(looksLikeVoiceId("Rachel"), false);
});

/* ── retries ───────────────────────────────────────────────────────── */

test("a rate limit is retried, and the eventual success is returned", async () => {
  let attempts = 0;
  const flaky = (async () => {
    attempts += 1;
    if (attempts < 3) return new Response("slow down", { status: 429 });
    return new Response(Buffer.from("ID3-fake"), { status: 200 });
  }) as typeof fetch;

  const result = await speak(
    { text: "oi", voice: "21m00Tcm4TlvDq8ikWAM" },
    { fetch: flaky, run: fakeRunner("1.0").run, key: "xi", provider: "elevenlabs", retryDelayMs: 0 },
  );

  assert.equal(attempts, 3);
  assert.equal(result.seconds, 1);
});

test("a bad key is NOT retried — retrying a 401 only wastes time", async () => {
  let attempts = 0;
  const refusing = (async () => {
    attempts += 1;
    return new Response(JSON.stringify({ detail: { message: "Invalid API key" } }), { status: 401 });
  }) as typeof fetch;

  await assert.rejects(
    speak(
      { text: "oi", voice: "21m00Tcm4TlvDq8ikWAM" },
      { fetch: refusing, run: fakeRunner().run, key: "xi", provider: "elevenlabs", retryDelayMs: 0 },
    ),
    /Invalid API key/,
  );
  assert.equal(attempts, 1, "a refusal is an answer, not a hiccup");
});

test("the error carries what the API said, not the raw envelope", async () => {
  const refusing = (async () =>
    new Response(JSON.stringify({ detail: { message: "quota_exceeded: 0 credits left" } }), {
      status: 402,
    })) as typeof fetch;

  await assert.rejects(
    speak(
      { text: "oi", voice: "21m00Tcm4TlvDq8ikWAM" },
      { fetch: refusing, run: fakeRunner().run, key: "xi", provider: "elevenlabs", retryDelayMs: 0 },
    ),
    /quota_exceeded: 0 credits left/,
  );
});

/* ── chunking ──────────────────────────────────────────────────────── */

test("short text is one chunk", () => {
  assert.deepEqual(chunkText("Uma frase só.", 100), ["Uma frase só."]);
});

test("long text splits at sentence boundaries, never mid-word", () => {
  const text = `${"a".repeat(40)}. ${"b".repeat(40)}. ${"c".repeat(40)}.`;
  const chunks = chunkText(text, 90);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 90, `"${chunk.length}" over the limit`);
  // Nothing may be lost or duplicated in the seam.
  assert.equal(chunks.join(" ").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});

test("a single sentence longer than the limit is split rather than refused", () => {
  const chunks = chunkText("x".repeat(250), 100);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) assert.ok(chunk.length <= 100);
});

test("each chunk is sent with its neighbours, so delivery does not lurch", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const capturing = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(Buffer.from("ID3-fake"), { status: 200 });
  }) as typeof fetch;

  const long = `${"a".repeat(3000)}. ${"b".repeat(3000)}.`;
  await speak(
    { text: long, voice: "21m00Tcm4TlvDq8ikWAM" },
    { fetch: capturing, run: fakeRunner("30").run, key: "xi", provider: "elevenlabs", retryDelayMs: 0 },
  );

  assert.ok(bodies.length > 1, "it was split");
  assert.equal(bodies[0].previous_text, undefined, "the first chunk has nothing before it");
  assert.ok(bodies[0].next_text, "but it knows what follows");
  assert.ok(bodies.at(-1)!.previous_text, "and the last knows what came before");
  assert.equal(bodies.at(-1)!.next_text, undefined);
});

test("eleven_v3 gets no cross-chunk context, because it rejects it", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const capturing = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(Buffer.from("ID3-fake"), { status: 200 });
  }) as typeof fetch;

  const long = `${"a".repeat(3000)}. ${"b".repeat(3000)}.`;
  await speak(
    { text: long, voice: "21m00Tcm4TlvDq8ikWAM", model: "eleven_v3" },
    { fetch: capturing, run: fakeRunner("30").run, key: "xi", provider: "elevenlabs", retryDelayMs: 0 },
  );

  assert.ok(bodies.length > 1);
  for (const body of bodies) {
    assert.equal(body.previous_text, undefined);
    assert.equal(body.next_text, undefined);
  }
});

/* ── the key's name ────────────────────────────────────────────────── */

test("the ElevenLabs key is accepted under any of its common names", () => {
  // Found the hard way: the key was already on this machine as
  // ELEVEN_LABS_API_KEY, and a provider chosen by "is a key present" answered
  // no. Three spellings are in circulation; refusing two of them is a puzzle
  // for the operator, not a safeguard.
  for (const name of ["ELEVENLABS_API_KEY", "ELEVEN_LABS_API_KEY", "XI_API_KEY"]) {
    assert.equal(chooseProvider({ [name]: "xi-key" }), "elevenlabs", `${name} must be honoured`);
    assert.equal(elevenLabsKey({ [name]: "xi-key" }), "xi-key");
  }
});

test("an empty key under one name does not mask a real one under another", () => {
  assert.equal(elevenLabsKey({ ELEVENLABS_API_KEY: "  ", ELEVEN_LABS_API_KEY: "real" }), "real");
});

test("no key under any name is an empty answer, not a throw", () => {
  assert.equal(elevenLabsKey({}), "");
});
