import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

import { ImageError, MAX_PROMPT_CHARS, generateImage, storeImage } from "../lib/imagegen.ts";

/**
 * Make a picture. Send nothing.
 *
 * ── Why this tool cannot send ───────────────────────────────────────────────
 *
 * ⚠ ARCHITECTURAL CONTRACT (PALS's LAW) — LLM OUTPUT IS UNVERIFIED BY DEFAULT
 *
 * A generated image IS model output, and it fails in the ways model output
 * fails: text in the picture comes out as letter-shaped noise, a count is wrong,
 * a detail nobody asked for is in the middle of the frame. The API reports none
 * of this — it answers 200 with an image in it. The only check that exists is
 * looking, and a tool that generated and sent in one call would have sent the
 * picture before anyone could look.
 *
 * So this returns the image as a content part and stops. `whatsapp_send_image`
 * takes it from there, by id. The gap between the two calls is the verification
 * layer, and it is the reason there are two tools rather than one.
 */

/**
 * eve warns above 3 MiB, and a content part is re-sent on every later turn of
 * the conversation. An image past that is stored and described rather than
 * shown — the alternative is one picture crowding out the chat it was made for.
 */
const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;

export default defineTool({
  description:
    "Generate an image from a description, using OpenAI's image model. This does NOT send anything — " +
    "it makes the picture, hands it back for you to look at, and returns an `id`. Look at what came " +
    "back before you do anything with it: image models misspell text, miscount objects and add things " +
    "nobody asked for, and none of that is reported as an error. When it is right, send it with " +
    "whatsapp_send_image and that id. When it is wrong, describe what is wrong in a new prompt and " +
    "generate again rather than sending it with an apology.",
  inputSchema: z.object({
    prompt: z
      .string()
      .min(1)
      .max(MAX_PROMPT_CHARS)
      .describe(
        "The picture, described in plain prose — subject, setting, style, and what matters most, in " +
          "that order. Say it in the language you like; the model reads both. Words you want to APPEAR " +
          "in the image should be short and quoted, and expect to check them: rendered text is where " +
          "these models fail most often.",
      ),
    size: z
      .enum(["square", "portrait", "landscape"])
      .default("square")
      .describe(
        "The shape. `square` is the safe default in a chat; `portrait` suits a poster or a story; " +
          "`landscape` suits a scene or a banner. These are the only three the model renders.",
      ),
    background: z
      .enum(["opaque", "transparent"])
      .default("opaque")
      .describe(
        "`transparent` for a logo, a sticker or something to be placed on another background — it " +
          "returns a PNG. Anything photographic wants `opaque`, which is smaller and arrives as a photo.",
      ),
    quality: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe(
        "Leave it empty. The default is tuned for a phone screen; `high` costs several times as much " +
          "for detail WhatsApp removes when it re-encodes the upload. Raise it only for something that " +
          "will be printed or opened on a desktop.",
      ),
  }),

  async execute({ prompt, size, background, quality }) {
    let image: Awaited<ReturnType<typeof generateImage>>;
    try {
      image = await generateImage({ prompt, size, background, quality }, {});
    } catch (error) {
      if (error instanceof ImageError) {
        return { ok: false as const, kind: error.kind, error: error.message };
      }
      throw error;
    }

    // Stored before it is shown. The model is about to see a picture and decide
    // whether to send it, and a decision about something that was never written
    // down is a decision about nothing.
    let stored: { id: string };
    try {
      stored = await storeImage({
        bytes: image.bytes,
        mimetype: image.mimetype,
        prompt: image.prompt,
        size: image.size,
      });
    } catch (error) {
      if (error instanceof ImageError) return { ok: false as const, kind: error.kind, error: error.message };
      throw error;
    }

    const shownInline = image.bytes.byteLength <= MAX_PREVIEW_BYTES;
    return {
      ok: true as const,
      id: stored.id,
      mimetype: image.mimetype,
      bytes: image.bytes.byteLength,
      size: image.size,
      prompt: image.prompt,
      // Only what is small enough to live in the conversation. The bytes on disk
      // are the ones that get sent either way.
      preview: shownInline ? image.bytes.toString("base64") : null,
    };
  },

  toModelOutput(output) {
    if (!output.ok) {
      const cause =
        output.kind === "config"
          ? "This is configuration on the agent, not something to retry"
          : output.kind === "refused"
            ? "The request was refused — rewrite the description or tell the user it will not be drawn"
            : "The provider failed after retries — it may work later";
      return {
        type: "text" as const,
        value: `No image was generated: ${output.error.replace(/\.$/, "")}. ${cause}.`,
      };
    }

    const kb = `${Math.round(output.bytes / 1024)} KB`;
    if (!output.preview) {
      return {
        type: "text" as const,
        value:
          `The image was generated (${output.size}, ${kb}) and stored as ${output.id}, but it is too ` +
          "large to show here, so it is UNSEEN. Say that to the user and let them decide — do not " +
          "describe it as though you had looked at it.",
      };
    }

    return toolOutput.content([
      toolOutputPart.text(
        `Generated from your prompt, stored as ${output.id} (${output.size}, ${kb}). Nothing has been ` +
          "sent. Look at it properly before you do: check any text in the picture letter by letter, " +
          "check the count of anything countable, and check that what is in the frame is what was " +
          "asked for. If it is right, send it with whatsapp_send_image and this id. If it is not, say " +
          "what is wrong and generate again — do not send it and apologise afterwards.",
      ),
      toolOutputPart.file(output.preview, { mediaType: output.mimetype }),
    ]);
  },
});
