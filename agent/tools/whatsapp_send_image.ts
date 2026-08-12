import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";
import { ImageError, loadImage } from "../lib/imagegen.ts";
import { imageSendApproval } from "../lib/send-policy.ts";

/**
 * Put a generated image in a chat.
 *
 * The second half of a deliberate split: `whatsapp_generate_image` makes the
 * picture and hands it back to be looked at, and this sends the one that was
 * looked at. Addressing it by id rather than by bytes is what makes that true —
 * the thing sent is the file on disk, not a description of it that a model
 * assembled from memory a few turns later.
 *
 * A generated image is not a photograph, and the difference matters more than it
 * looks. It arrives in the same bubble a real photo arrives in, and the
 * recipient has nothing to tell them a machine drew it. That is the user's call
 * to make, not this tool's — which is why sending to anyone other than the user
 * pauses for an approval, and why the model is told to say what the picture is.
 */
export default defineTool({
  description:
    "Send an image you generated with whatsapp_generate_image, by its `id`. Sends the actual picture, " +
    "not a link. With no `to` it goes to the user's OWN chat, which reaches nobody else — prefer that " +
    "for anything they will decide what to do with. A `to` is a real send to that contact and cannot " +
    "be recalled, and the bridge refuses anyone not allowlisted. Only send an image you have actually " +
    "looked at.",
  inputSchema: z.object({
    id: z
      .string()
      .min(1)
      .describe("The `id` from whatsapp_generate_image, copied verbatim. It addresses one stored image."),
    to: z
      .string()
      .min(1)
      .optional()
      .describe(
        "An allowlisted contact, exactly as whatsapp_resolve_contact returned it. Omit to write to " +
          "the user's own chat.",
      ),
    caption: z
      .string()
      .max(500)
      .optional()
      .describe(
        "One short line sent with the picture. When it goes to someone else, this is where it is said " +
          "that the image was generated — a picture that could be mistaken for a photograph should not " +
          "arrive as one.",
      ),
  }),

  /** One tap for a third party; nothing for the user's own chat. */
  approval: imageSendApproval,

  async execute({ id, to, caption }, ctx) {
    let image: Awaited<ReturnType<typeof loadImage>>;
    try {
      image = await loadImage(id);
    } catch (error) {
      if (error instanceof ImageError) return { ok: false as const, stage: "lookup" as const, error: error.message };
      throw error;
    }

    try {
      if (to) {
        const sent = await bridge.sendMedia(
          { to, bytes: image.bytes, mimetype: image.mimetype, caption, kind: "image" },
          ctx.abortSignal,
        );
        return {
          ok: true as const,
          self: false as const,
          // The name the transport actually matched, falling back to the one
          // that was asked for when it reports none. The bridge no longer
          // settles for a near match — one that resolves elsewhere is refused
          // before anything is sent (`assertResolvedMatches`) — so reaching this
          // line means it went where it was addressed.
          destination: sent.resolvedName ?? to,
          bytes: image.bytes.byteLength,
          prompt: image.prompt,
        };
      }

      // The self chat is not a roster contact — `/send/media` cannot address the
      // account itself. The transport resolves its own address instead.
      const written = await bridge.writeSelfImage(
        { bytes: image.bytes, mimetype: image.mimetype, caption, kind: "image" },
        ctx.abortSignal,
      );
      return {
        ok: true as const,
        self: true as const,
        destination: written.chat,
        bytes: image.bytes.byteLength,
        prompt: image.prompt,
      };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false as const, stage: "send" as const, error: error.message };
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      return {
        type: "text" as const,
        value:
          output.stage === "lookup"
            ? `Nothing was sent: ${output.error}`
            : `The image exists but WhatsApp did not accept it: ${output.error}`,
      };
    }

    const size = `${Math.round(output.bytes / 1024)} KB`;
    const lines = [
      output.self
        ? `The image (${size}) is in the user's own chat — it is on their phone now.`
        : `The image (${size}) was SENT to "${output.destination}". It cannot be recalled. Say that it ` +
          "was a generated picture, not a photograph, in your reply to the user.",
    ];
    return { type: "text" as const, value: lines.join(" ") };
  },
});
