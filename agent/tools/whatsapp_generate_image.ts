import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

import { ImageError, MAX_PROMPT_CHARS, generateImage, previewFor, storeImage } from "../lib/imagegen.ts";
import { describeSize, fitsInContext } from "../lib/tool-output.ts";

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
 * What is shown is a DOWNSCALE of what was made.
 *
 * A generated JPEG runs to a couple of hundred kilobytes, and a content part is
 * re-sent on every later turn of the conversation — so the full image would
 * spend a slice of the context window over and over for a picture the model
 * looked at once. The size that is checked here is therefore the preview's, and
 * the budget is the shared one in `tool-output.ts` rather than a number invented
 * in this file: a ceiling that does not move with the model's window is a guard
 * that silently stops guarding.
 */

export default defineTool({
  description:
    "Generate an image from a description, using OpenAI's image model. Use it when the user asks for " +
    "a picture to be made — not to illustrate an answer they did not ask to see illustrated. " +
    "This does NOT send anything — " +
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

  async execute({ prompt, size, background, quality }, ctx) {
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

    // A failed downscale is not a failed generation: the picture is stored and
    // sendable, it just cannot be shown, and that is reported rather than
    // papered over with the full-size bytes.
    const preview = await previewFor(image.bytes);
    const affordable = preview
      ? fitsInContext(preview.byteLength, { sessionId: ctx.session?.id })
      : { ok: false };

    return {
      ok: true as const,
      id: stored.id,
      mimetype: image.mimetype,
      bytes: image.bytes.byteLength,
      size: image.size,
      prompt: image.prompt,
      // The small copy, and only when it fits. The bytes on disk are the ones
      // that get sent either way — the user receives the full-size image.
      preview: preview && affordable.ok ? preview.toString("base64") : null,
      previewBytes: preview?.byteLength ?? 0,
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

    const kb = describeSize(output.bytes);
    if (!output.preview) {
      return {
        type: "text" as const,
        value:
          `The image was generated (${output.size}, ${kb}) and stored as ${output.id}, but no copy ` +
          "small enough to show could be made, so it is UNSEEN. You can still send it with " +
          "whatsapp_send_image — but say plainly that you have not looked at it and let the user " +
          "decide. Do not describe it as though you had.",
      };
    }

    return toolOutput.content([
      toolOutputPart.text(
        `Generated from your prompt, stored as ${output.id} (${output.size}, ${kb} — shown below as a ` +
          `smaller copy; the full-size one is what gets sent). Nothing has been ` +
          "sent. Look at it properly before you do: check any text in the picture letter by letter, " +
          "check the count of anything countable, and check that what is in the frame is what was " +
          "asked for. If it is right, send it with whatsapp_send_image and this id. If it is not, say " +
          "what is wrong and generate again — do not send it and apologise afterwards.",
      ),
      // The preview is always a JPEG, whatever the stored image is — the
      // downscale re-encodes, so declaring the original's type here would label
      // a JPEG as a PNG.
      toolOutputPart.file(output.preview, { mediaType: "image/jpeg" }),
    ]);
  },
});
