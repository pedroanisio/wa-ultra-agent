import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertTranscribeConfigured,
  transcribeAudio,
  transcribeConfig,
} from "../agent/lib/transcribe.ts";

/**
 * Whether voice notes leave the host is the operator's decision, not this
 * agent's (SPEC §8.4). So there is no built-in provider: the endpoint is
 * configured, and pointing it at localhost keeps audio on the machine while
 * pointing it at a hosted API does not. Unset means the capability is absent
 * and says so, rather than failing at request time.
 */

const env = {
  WA_TRANSCRIBE_URL: "https://api.example/v1/audio/transcriptions",
  WA_TRANSCRIBE_MODEL: "whisper-large-v3",
  WA_TRANSCRIBE_KEY: "sk-test",
};

const audio = { base64: Buffer.from("fake ogg").toString("base64"), mediaType: "audio/ogg", filename: "nota.ogg" };

/* ---------------------------------------------------------------- *
 * Configuration
 * ---------------------------------------------------------------- */

test("config: absent when no endpoint is set", () => {
  assert.equal(transcribeConfig({}), null);
});

test("config: absent when the endpoint is only whitespace", () => {
  assert.equal(transcribeConfig({ WA_TRANSCRIBE_URL: "   " }), null);
});

test("config: reads url, model and key", () => {
  assert.deepEqual(transcribeConfig(env), {
    url: env.WA_TRANSCRIBE_URL,
    model: "whisper-large-v3",
    apiKey: "sk-test",
  });
});

test("config: a key is optional, so a local server needs no credential", () => {
  const cfg = transcribeConfig({ WA_TRANSCRIBE_URL: "http://127.0.0.1:8080/v1/audio/transcriptions" });
  assert.equal(cfg?.apiKey, undefined);
});

test("config: uses OPENAI_API_KEY when the endpoint is OpenAI and no explicit key is set", () => {
  const cfg = transcribeConfig({
    WA_TRANSCRIBE_URL: "https://api.openai.com/v1/audio/transcriptions",
    OPENAI_API_KEY: "sk-openai",
  });
  assert.equal(cfg?.apiKey, "sk-openai");
});

test("config: NEVER sends OPENAI_API_KEY to a non-OpenAI endpoint", () => {
  for (const url of [
    "https://api.groq.com/openai/v1/audio/transcriptions",
    "https://evil.example/v1/audio/transcriptions",
    "http://127.0.0.1:8080/v1/audio/transcriptions",
    "https://api.openai.com.evil.example/v1/audio/transcriptions",
  ]) {
    const cfg = transcribeConfig({ WA_TRANSCRIBE_URL: url, OPENAI_API_KEY: "sk-openai" });
    assert.equal(cfg?.apiKey, undefined, `must not leak the OpenAI key to ${url}`);
  }
});

test("config: an explicit WA_TRANSCRIBE_KEY wins over OPENAI_API_KEY", () => {
  const cfg = transcribeConfig({
    WA_TRANSCRIBE_URL: "https://api.openai.com/v1/audio/transcriptions",
    WA_TRANSCRIBE_KEY: "sk-explicit",
    OPENAI_API_KEY: "sk-openai",
  });
  assert.equal(cfg?.apiKey, "sk-explicit");
});

test("config: falls back to a default model name", () => {
  const cfg = transcribeConfig({ WA_TRANSCRIBE_URL: "http://x/v1/audio/transcriptions" });
  assert.ok(cfg?.model);
});

test("assert: names the env var to set when transcription is unconfigured", () => {
  assert.throws(() => assertTranscribeConfigured({}), /WA_TRANSCRIBE_URL/);
});

test("assert: a hosted endpoint without a key fails now, not after downloading the audio", () => {
  assert.throws(
    () => assertTranscribeConfigured({ WA_TRANSCRIBE_URL: "https://api.openai.com/v1/audio/transcriptions" }),
    /WA_TRANSCRIBE_KEY/,
  );
});

test("assert: a local endpoint needs no key", () => {
  for (const url of [
    "http://127.0.0.1:8080/v1/audio/transcriptions",
    "http://localhost:8080/v1/audio/transcriptions",
    "http://192.168.1.50:8080/v1/audio/transcriptions",
    "http://10.0.0.4:8080/v1/audio/transcriptions",
    "http://whisper:8080/v1/audio/transcriptions",
  ]) {
    assert.doesNotThrow(() => assertTranscribeConfigured({ WA_TRANSCRIBE_URL: url }), url);
  }
});

test("assert: a hosted endpoint with a key is accepted", () => {
  assert.doesNotThrow(() =>
    assertTranscribeConfigured({
      WA_TRANSCRIBE_URL: "https://api.openai.com/v1/audio/transcriptions",
      WA_TRANSCRIBE_KEY: "sk-test",
    }),
  );
});

/* ---------------------------------------------------------------- *
 * The request
 * ---------------------------------------------------------------- */

test("transcribe: posts the audio and returns the text", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchImpl = async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ text: "reunião mudou para quinta" }), { status: 200 });
  };

  const result = await transcribeAudio(audio, transcribeConfig(env)!, fetchImpl);

  assert.equal(result.text, "reunião mudou para quinta");
  assert.equal(seen?.url, env.WA_TRANSCRIBE_URL);
  assert.equal(seen?.init.method, "POST");
  assert.ok(seen?.init.body instanceof FormData);
});

test("transcribe: sends the configured model in the form", async () => {
  let form: FormData | undefined;
  const fetchImpl = async (_url: string, init: RequestInit) => {
    form = init.body as FormData;
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  };

  await transcribeAudio(audio, transcribeConfig(env)!, fetchImpl);
  assert.equal(form?.get("model"), "whisper-large-v3");
  assert.ok(form?.get("file"), "the audio is attached as a file part");
});

test("transcribe: authorises when a key is set", async () => {
  let headers: Record<string, string> | undefined;
  const fetchImpl = async (_url: string, init: RequestInit) => {
    headers = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  };

  await transcribeAudio(audio, transcribeConfig(env)!, fetchImpl);
  assert.equal(headers?.authorization, "Bearer sk-test");
});

test("transcribe: sends no Authorization header to a keyless local endpoint", async () => {
  let headers: Record<string, string> | undefined;
  const fetchImpl = async (_url: string, init: RequestInit) => {
    headers = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  };

  const cfg = transcribeConfig({ WA_TRANSCRIBE_URL: "http://127.0.0.1:8080/v1/audio/transcriptions" })!;
  await transcribeAudio(audio, cfg, fetchImpl);
  assert.equal(headers?.authorization, undefined);
});

test("transcribe: surfaces a failed response with its status", async () => {
  const fetchImpl = async () => new Response("model not found", { status: 404 });
  await assert.rejects(() => transcribeAudio(audio, transcribeConfig(env)!, fetchImpl), /404/);
});

test("transcribe: rejects a response with no text rather than returning empty", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ nope: true }), { status: 200 });
  await assert.rejects(() => transcribeAudio(audio, transcribeConfig(env)!, fetchImpl), /text/i);
});

test("transcribe: names the endpoint when it cannot be reached", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(
    () => transcribeAudio(audio, transcribeConfig(env)!, fetchImpl),
    /api\.example/,
  );
});
