import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";
import { ArtifactError, readArtifact, readRenderDefects, resolveArtifact } from "../lib/frameforge.ts";

/**
 * Put a FrameForge render on the user's phone.
 *
 * The FrameForge connection can author and render a document, but everything it
 * produces lives in a scratch directory the user will never open. This is the
 * last step: the page the model just looked at becomes a photo in a WhatsApp
 * chat, or the assembled PDF becomes a file they can forward.
 *
 * ⚠ ARCHITECTURAL CONTRACT (PALS's LAW) — LLM OUTPUT IS UNVERIFIED BY DEFAULT
 *
 * A render that returns ok:true can still be unusable: an object that painted
 * no ink is invisible, text stacked on text is unreadable, a clipped column has
 * silently lost its last line. The model is asked to check for exactly these
 * and will sometimes say it did. So this tool reads the renderer's own
 * `diagnostics.json` off disk before sending, and refuses when it reports one
 * of them. `force` exists because "the overlap is the design" is a real answer
 * — but it has to be given deliberately, and the defect is reported back so it
 * can be said out loud rather than shipped quietly.
 */
/**
 * One failure shape, so a refusal and a bridge error read the same on the way
 * out: `blocked` says which of the two it was, and `defects` is what the render
 * itself reported.
 */
function failed(error: string) {
  return { ok: false as const, blocked: false, defects: [] as readonly string[], error };
}

export default defineTool({
  description:
    "Deliver a rendered FrameForge document into WhatsApp — the actual picture or PDF, not a link. " +
    "Pass the `uri` from the render result: frameforge://session/<id>/page/<n>.png for one page, or " +
    "frameforge://session/<id>/document.pdf for the whole thing (render with to='pdf' first). " +
    "With no `to` it goes to the user's OWN chat, which reaches nobody else and needs no approval — " +
    "prefer that. A `to` sends it to that contact, and the bridge refuses anyone not allowlisted. " +
    "Before sending it re-reads the render's diagnostics and refuses a page with invisible objects, " +
    "unreadable text, collisions or clipped content; fix the document and render again rather than " +
    "forcing it.",
  inputSchema: z.object({
    uri: z
      .string()
      .min(1)
      .describe(
        "The artifact URI, copied verbatim from the render result — " +
          "frameforge://session/<id>/page/1.png or frameforge://session/<id>/document.pdf.",
      ),
    caption: z
      .string()
      .max(500)
      .optional()
      .describe("One short line sent with the attachment. Omit when the document speaks for itself."),
    to: z
      .string()
      .min(1)
      .optional()
      .describe(
        "An allowlisted contact, exactly as whatsapp_resolve_contact returned it. Omit to write to " +
          "the user's own chat, which is the right default for anything they will decide what to do with.",
      ),
    force: z
      .boolean()
      .default(false)
      .describe(
        "Send even though the render reported a defect. Only when the user has been told what the " +
          "defect is and wants it anyway — never to get past a refusal quietly.",
      ),
  }),
  async execute({ uri, caption, to, force }, ctx) {
    let artifact;
    try {
      artifact = resolveArtifact(uri);
    } catch (error) {
      if (error instanceof ArtifactError) return failed(error.message);
      throw error;
    }

    const health = await readRenderDefects(artifact.sessionId);
    if (!health.rendered && !force) {
      return failed(`the last render in session "${artifact.sessionId}" failed — there is nothing good to send.`);
    }
    if (health.defects.length > 0 && !force) {
      return { ok: false as const, blocked: true, defects: health.defects, error: health.defects.join("; ") };
    }

    let bytes: Uint8Array;
    try {
      bytes = await readArtifact(artifact);
    } catch (error) {
      if (error instanceof ArtifactError) return failed(error.message);
      throw error;
    }

    try {
      if (to) {
        const sent = await bridge.sendMedia(
          {
            to,
            bytes,
            mimetype: artifact.mimetype,
            caption,
            kind: artifact.kind,
            filename: artifact.filename,
          },
          ctx.abortSignal,
        );
        return {
          ok: true as const,
          // `to` was the DOM path's echo of the recipient and is no longer
          // returned; `resolvedName` is the chat the roster actually matched.
          destination: sent.resolvedName ?? to,
          self: false as const,
          kind: artifact.kind,
          bytes: bytes.byteLength,
          unverified: !health.verified,
          forced: force && health.defects.length > 0 ? health.defects : [],
        };
      }

      const written = await bridge.writeSelfImage(
        {
          bytes,
          mimetype: artifact.mimetype,
          caption,
          kind: artifact.kind,
          filename: artifact.filename,
        },
        ctx.abortSignal,
      );
      return {
        ok: true as const,
        destination: written.chat,
        self: true as const,
        kind: artifact.kind,
        bytes: bytes.byteLength,
        unverified: !health.verified,
        forced: force && health.defects.length > 0 ? health.defects : [],
      };
    } catch (error) {
      if (error instanceof BridgeError) return failed(error.message);
      throw error;
    }
  },

  toModelOutput(output) {
    if (!output.ok) {
      if (output.blocked) {
        return {
          type: "text" as const,
          value:
            `NOT sent. The render reports: ${output.defects.join("; ")}. These are the defects a ` +
            "thumbnail cannot show. Fix the document and render again. Only pass force:true if the " +
            "user has been told what the defect is and wants it sent regardless.",
        };
      }
      return { type: "text" as const, value: `Nothing was sent: ${output.error}` };
    }

    const what = output.kind === "document" ? "The PDF" : "The page";
    const size = `${Math.round(output.bytes / 1024)} KB`;
    const lines = [
      output.self
        // The self chat's identity comes back as the account's own JID, which
        // is a constant and means nothing to a reader — there is no recipient
        // here to disambiguate, so it is not worth a line.
        ? `${what} (${size}) is in the user's own chat — it is on their phone now.`
        : `${what} (${size}) was SENT to "${output.destination}". It cannot be recalled.`,
    ];
    if (output.unverified) {
      lines.push(
        "No diagnostics file was found for that session, so the render was NOT machine-checked. Say so.",
      );
    }
    if (output.forced.length > 0) {
      lines.push(`Sent with known defects: ${output.forced.join("; ")}. Say this to the user.`);
    }
    return { type: "text" as const, value: lines.join(" ") };
  },
});
