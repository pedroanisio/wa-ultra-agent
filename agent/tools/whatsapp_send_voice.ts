import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";
import { MAX_SPEECH_CHARS, speak } from "../lib/speech.ts";
import { sendApproval } from "../lib/send-policy.ts";

/**
 * Send a voice note.
 *
 * ── Why this is gated harder than text ──────────────────────────────────────
 *
 * A text message from an agent is deniable as a paste. A voice note is not: it
 * arrives as *speech*, in a medium people read as a person being present, and
 * the recipient has no way to tell it was typed. It also cannot be skim-read —
 * they have to stop and listen — so it spends more of their attention than the
 * same words in text.
 *
 * The voice is a synthetic one. With ElevenLabs configured it is a convincing
 * one, which sharpens rather than softens the point: the more realistic it
 * sounds, the less the recipient can tell a machine read it. It should still not
 * be pointed at a clone of the user's own voice — a stock voice is a stranger
 * reading their words, a cloned one is them saying something they never said.
 *
 * It carries the same approval policy as text sending, plus its own floor: no
 * voice note goes out without the user having seen the words.
 */
export default defineTool({
  description:
    "Send a WhatsApp VOICE NOTE — synthesised speech, arriving as a push-to-talk bubble with a " +
    "waveform, not a file attachment. Use it only when the user explicitly asks for a voice message. " +
    "Do NOT reach for it as a nicer way to deliver text: it cannot be skim-read, it demands the " +
    "recipient stop and listen, and it arrives in a medium that reads as a person speaking when it is " +
    "a machine reading. The synthetic voice does not sound like the user, and that is deliberate.",
  inputSchema: z.object({
    to: z
      .string()
      .optional()
      .describe(
        "Contact or group name, exactly as WhatsApp shows it. LEAVE IT EMPTY to send to the user's " +
          "own chat, which reaches nobody else — the right way to let them hear a note before it goes " +
          "to a person.",
      ),
    text: z
      .string()
      .min(1)
      .max(MAX_SPEECH_CHARS)
      .describe(
        "What will be spoken, in the language of the conversation. Write it to be HEARD: short " +
          "sentences, no bullet points, no markdown, no links — none of which survive being read aloud. " +
          "Long text is split at sentence boundaries automatically, but length is charged per character " +
          "and paid for in the listener's attention, so keep it to what someone would actually say.",
      ),
    voice: z
      .string()
      .optional()
      .describe(
        "Which voice speaks. On ElevenLabs this is a voice ID, not a display name; on OpenAI it is a " +
          "name such as `alloy`. Leave it empty — the operator has configured one, and guessing an id " +
          "produces a 404 rather than a different voice.",
      ),
  }),

  /**
   * The same policy text sending uses, for the same reason — and it matters more
   * here, because a spoken commitment cannot be quietly edited afterwards the
   * way a text one can.
   */
  approval: sendApproval,

  async execute({ to, text, voice }, ctx) {
    // No recipient means the user's own chat. Not a default chosen for
    // convenience: it is the only target that reaches nobody else, so it is
    // where an unheard voice note belongs.
    const toSelf = !to?.trim();

    let note: Awaited<ReturnType<typeof speak>>;
    try {
      note = await speak({ text, voice }, {});
    } catch (error) {
      // Synthesis failing is a configuration or a provider problem, and it must
      // not be reported as though WhatsApp refused something.
      return { ok: false as const, stage: "synthesis" as const, error: (error as Error).message };
    }

    try {
      const payload = {
        kind: "voice" as const,
        mimetype: note.mimetype,
        durationSeconds: note.seconds,
        dataBase64: note.audio.toString("base64"),
      };

      // The self chat is not a roster contact — `/send/media` cannot address the
      // account itself and answers 404 for it. The transport resolves its own
      // address instead.
      const sent = toSelf
        ? await bridge.sendSelfMedia(payload, ctx.abortSignal)
        : await bridge.sendMediaAs({ to: to as string, ...payload }, ctx.abortSignal);

      return {
        ok: true as const,
        id: sent.id,
        to: toSelf ? "your own chat" : to,
        seconds: note.seconds,
        bytes: note.audio.length,
        spoken: text,
      };
    } catch (error) {
      if (error instanceof BridgeError) {
        return { ok: false as const, stage: "send" as const, error: error.message };
      }
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      return {
        type: "text" as const,
        value:
          output.stage === "synthesis"
            ? `No audio was produced, so NOTHING was sent: ${output.error}`
            : `The audio was produced but WhatsApp did not accept it: ${output.error}`,
      };
    }

    return {
      type: "text" as const,
      value:
        `Sent as a ${output.seconds}-second voice note. It plays as speech on their phone — say what ` +
        "was said, in one line, so the user has a record of it in text.",
    };
  },
});
