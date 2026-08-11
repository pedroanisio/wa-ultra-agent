/**
 * Turning a voice note into text.
 *
 * There is deliberately no built-in provider. Whether a private voice message
 * leaves this machine is the operator's decision, not the agent's, and the two
 * reasonable answers need the same code: point `WA_TRANSCRIBE_URL` at a local
 * whisper.cpp server and nothing leaves the host; point it at a hosted API and
 * it does. Both speak the OpenAI `/audio/transcriptions` shape, so one seam
 * covers local, Groq, OpenAI, and anything else that copies it.
 *
 * Unset means the capability is absent, and the tool says so plainly instead of
 * failing at request time with a network error.
 */

export interface TranscribeConfig {
  url: string;
  model: string;
  apiKey?: string;
}

export interface AudioPayload {
  base64: string;
  mediaType: string;
  filename?: string;
}

/** Most OpenAI-compatible servers accept this name, including whisper.cpp. */
const DEFAULT_MODEL = "whisper-1";

/**
 * Exactly OpenAI's own host, and nothing that merely looks like it.
 *
 * `hostname` is parsed rather than string-matched on purpose:
 * `api.openai.com.evil.example` contains "api.openai.com" as a substring, and a
 * credential handed to that host is a credential handed to a stranger.
 */
function isOpenAiHost(url: string): boolean {
  try {
    return new URL(url).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

export function transcribeConfig(env: Record<string, string | undefined>): TranscribeConfig | null {
  const url = (env.WA_TRANSCRIBE_URL || "").trim();
  if (!url) return null;

  // A convenience with a hard boundary: someone who has set OPENAI_API_KEY and
  // pointed this at OpenAI should not have to copy the same secret into a second
  // variable. It is never used for any other endpoint — not Groq, not a local
  // server, not a look-alike host.
  const explicit = (env.WA_TRANSCRIBE_KEY || "").trim();
  const inherited = isOpenAiHost(url) ? (env.OPENAI_API_KEY || "").trim() : "";

  return {
    url,
    model: (env.WA_TRANSCRIBE_MODEL || "").trim() || DEFAULT_MODEL,
    apiKey: explicit || inherited || undefined,
  };
}

/**
 * Is this endpoint on the machine or the LAN?
 *
 * Decides only whether a credential is required. A local whisper server needs
 * none; anything reachable over the internet almost certainly does, and finding
 * that out through a 401 costs a browser download of the audio first.
 */
export function isLocalEndpoint(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }

  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // A bare hostname with no dots is a container or LAN name, e.g. "whisper".
  return !host.includes(".");
}

export function assertTranscribeConfigured(env: Record<string, string | undefined>): TranscribeConfig {
  const config = transcribeConfig(env);
  if (!config) {
    throw new Error(
      "Transcription is not configured, so voice notes cannot be read. Set WA_TRANSCRIBE_URL to an " +
        "OpenAI-compatible /audio/transcriptions endpoint — a local whisper.cpp server keeps the " +
        "audio on this machine; a hosted API does not. WA_TRANSCRIBE_MODEL and WA_TRANSCRIBE_KEY " +
        "are optional.",
    );
  }

  if (!config.apiKey && !isLocalEndpoint(config.url)) {
    throw new Error(
      `WA_TRANSCRIBE_URL points at ${new URL(config.url).host}, which is not a local endpoint, but ` +
        "WA_TRANSCRIBE_KEY is unset. Set the key, or point the URL at a local transcription server. " +
        "Failing here saves downloading the audio only to be rejected.",
    );
  }

  return config;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function transcribeAudio(
  audio: AudioPayload,
  config: TranscribeConfig,
  fetchImpl: FetchLike = fetch,
): Promise<{ text: string }> {
  const bytes = Buffer.from(audio.base64, "base64");
  const form = new FormData();
  form.append("model", config.model);
  form.append(
    "file",
    new Blob([bytes], { type: audio.mediaType }),
    audio.filename || "voice-note.ogg",
  );

  // No content-type header: FormData sets its own multipart boundary.
  const headers: Record<string, string> = {};
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  let response: Response;
  try {
    response = await fetchImpl(config.url, { method: "POST", body: form, headers });
  } catch (cause) {
    throw new Error(
      `Could not reach the transcription endpoint at ${config.url}: ${(cause as Error).message}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `The transcription endpoint returned HTTP ${response.status}. ${detail.slice(0, 300)}`.trim(),
    );
  }

  const body = (await response.json().catch(() => ({}))) as { text?: unknown };
  if (typeof body.text !== "string" || !body.text.trim()) {
    throw new Error(
      "The transcription endpoint returned no `text` field. Check that WA_TRANSCRIBE_URL points at " +
        "an OpenAI-compatible /audio/transcriptions route.",
    );
  }

  return { text: body.text.trim() };
}
