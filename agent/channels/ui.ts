import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { defineChannel, GET, POST } from "eve/channels";
import { httpBasic, routeAuth } from "eve/channels/auth";

import { bridge } from "../lib/bridge.ts";
import { writeEnvFileSafely } from "../lib/env-file.ts";
import { qrMatrix } from "../lib/qr.ts";
import { snapshot as turnSnapshot } from "../lib/turn-log.ts";
import { PAGE } from "../lib/ui-page.ts";
import {
  UiError,
  conversationScreen,
  draftReview,
  preferencesScreen,
  queueScreen,
  resolveQueueItem,
  savePreferences,
  sendFromUi,
  setupScreen,
  toolsScreen,
  type UiDeps,
} from "../lib/ui-api.ts";

/**
 * The web UI: a queue you can act on, and the four screens around it.
 *
 * ── Why it lives in the agent ───────────────────────────────────────────────
 * The agent is the only process holding both halves of what these screens need:
 * the bridge token, and the turn log. Putting the UI in the bridge would mean
 * giving the bridge the agent's state; putting it in its own service would mean
 * a third holder of the bridge token. Here, nothing moves — the browser talks
 * to the agent, the agent talks to the bridge, exactly as every tool does.
 *
 * ── Why the routes are at the root ──────────────────────────────────────────
 * eve mounts a custom channel's routes at the root and uses the file stem as
 * the channel's identity, not as a URL prefix (see `agent/channels/console.ts`
 * and the note in `whatsapp-bridge/src/whatsapp.js`). So every path here is
 * namespaced by hand under `/ui`.
 *
 * ── Authentication ──────────────────────────────────────────────────────────
 * The same walk `agent/channels/eve.ts` uses, for the same reason: this agent
 * can read and send WhatsApp as the operator, so an open endpoint hands the
 * account to whoever finds the port. `routeAuth` is eve's own walk, so the UI
 * and the API cannot drift apart on who is allowed in — and an unset password
 * fails at boot rather than serving an ungated page.
 */

const password = process.env.WA_UI_PASSWORD;

if (!password) {
  throw new Error("WA_UI_PASSWORD is not set. Add it to .env before starting the agent.");
}

const auth = [
  httpBasic({ username: process.env.WA_UI_USERNAME ?? "me", password }, { realm: "WhatsApp Agent" }),
];

/**
 * Where `.env` is, when it has been mounted.
 *
 * Unset means the Preferences screen is read-only, which is the state of any
 * deployment that did not opt into a writable configuration file. It is
 * reported on the page rather than discovered when a save silently does
 * nothing.
 */
const ENV_FILE = process.env.WA_ENV_FILE?.trim() || "";

async function readEnvFile(): Promise<string | null> {
  if (!ENV_FILE) return null;
  try {
    return await readFile(ENV_FILE, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write the file, preferring the atomic path and surviving without it.
 *
 * The rename-over-a-sibling dance fails on Docker, where `.env` is bind-mounted
 * as a single file and is therefore a mount point (EBUSY). `writeEnvFileSafely`
 * carries that reasoning and the fallback; here it is only handed the calls it
 * needs.
 */
async function writeEnvFile(text: string): Promise<void> {
  if (!ENV_FILE) throw new UiError("no .env file is mounted here", 409);
  const temporary = join(dirname(ENV_FILE), `.env.${process.pid}.tmp`);
  await writeEnvFileSafely(ENV_FILE, text, temporary, { writeFile, rename, unlink });
}

const deps: UiDeps = {
  bridge,
  env: process.env,
  readEnvFile,
  writeEnvFile,
  turns: () => turnSnapshot(),
};

/** Authenticate, then run the handler, translating a refusal into its status. */
async function guarded(
  request: Request,
  handler: () => Promise<unknown>,
): Promise<Response> {
  const rejection = await authFailure(request);
  if (rejection) return rejection;

  try {
    return Response.json(await handler());
  } catch (error) {
    if (error instanceof UiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    // Never the stack, and never the message of something unrecognised: this
    // page is behind a password, but a 500 body is the one place a token or a
    // path tends to leak out of an error nobody anticipated.
    console.error("ui: unhandled failure", error);
    return Response.json({ error: "that failed unexpectedly; check the agent's logs" }, { status: 500 });
  }
}

/**
 * `null` when the caller is allowed in, otherwise the response to send back.
 *
 * ── The shape that matters ──────────────────────────────────────────────────
 * `routeAuth` does NOT throw on a rejected walk. It RETURNS the 401 —
 * challenge header and all — and returns a plain auth context when the caller
 * is admitted. Guarding it with a try/catch therefore admits everybody: the
 * rejection arrives as a perfectly ordinary return value, the catch never runs,
 * and every route behind it is open. Discriminating on `Response` is the whole
 * check, which is why it is one line with a paragraph over it.
 */
export async function authFailure(request: Request): Promise<Response | null> {
  const result = await routeAuth(request, auth);
  return result instanceof Response ? result : null;
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new UiError("that request body is not JSON", 400);
  }
}

export default defineChannel({
  routes: [
    GET("/ui", async (request) => {
      const rejection = await authFailure(request);
      if (rejection) return rejection;
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          // The page is a shell; everything on it is fetched fresh. Caching it
          // is how an operator ends up looking at last week's send gate.
          "cache-control": "no-store",
          // The page loads nothing from anywhere: no CDN, no font, no image.
          // Saying so means an injected string cannot become a request either.
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      });
    }),

    /* ── the queue ─────────────────────────────────────────────────── */

    GET("/ui/api/queue", (request) => guarded(request, () => queueScreen(deps))),

    GET("/ui/api/conversation", (request) =>
      guarded(request, () => {
        const chat = new URL(request.url).searchParams.get("chat") ?? "";
        return conversationScreen(deps, chat);
      }),
    ),

    POST("/ui/api/resolve", (request) =>
      guarded(request, async () => {
        const input = await body<{ ref?: string; action?: string }>(request);
        if (!input.ref) throw new UiError("a ref is required", 400);
        const action = input.action ?? "accept";
        if (!["accept", "dismiss", "done", "dropped"].includes(action)) {
          throw new UiError(`unknown action: ${action}`, 400);
        }
        return resolveQueueItem(deps, input.ref, action as never);
      }),
    ),

    /* ── edit & send ───────────────────────────────────────────────── */

    POST("/ui/api/draft", (request) =>
      guarded(request, async () => {
        const input = await body<{ draft?: string; modelFlag?: boolean }>(request);
        return draftReview(input.draft ?? "", Boolean(input.modelFlag));
      }),
    ),

    POST("/ui/api/send", (request) =>
      guarded(request, async () => {
        const input = await body<{
          to?: string;
          message?: string;
          ref?: string;
          toSelf?: boolean;
          quoted?: { messageId: string; sender?: string };
        }>(request);
        return sendFromUi(deps, {
          to: input.to ?? "",
          message: input.message ?? "",
          ref: input.ref,
          toSelf: input.toSelf,
          quoted: input.quoted,
        });
      }),
    ),

    /* ── setup ─────────────────────────────────────────────────────── */

    GET("/ui/api/setup", (request) => guarded(request, () => setupScreen(deps))),

    POST("/ui/api/pair/phone", (request) =>
      guarded(request, async () => {
        const input = await body<{ phone?: string }>(request);
        const phone = input.phone?.trim();
        if (!phone) throw new UiError("a phone number is required", 400);
        return callBridge("/transport/pair/phone", { phone });
      }),
    ),

    /**
     * The rotating pairing code, re-encoded as a matrix the page can paint.
     *
     * Transformed here rather than forwarded: the transport emits the raw
     * payload, and a browser cannot turn that into a symbol on its own. Doing
     * it in this hop keeps the QR codec on one side of the wire and leaves the
     * page painting cells.
     *
     * Every branch closes the upstream read. A stream left open on the bridge
     * is a QR channel left open on the transport, and the next attempt to pair
     * finds one already running.
     */
    GET("/ui/api/pair/qr", async (request) => {
      const rejection = await authFailure(request);
      if (rejection) return rejection;

      const url = process.env.WA_BRIDGE_URL;
      const token = process.env.WA_BRIDGE_TOKEN;
      if (!url || !token) {
        return Response.json({ error: "the bridge is not configured" }, { status: 503 });
      }

      const upstream = new AbortController();
      request.signal?.addEventListener("abort", () => upstream.abort());

      let source: Response;
      try {
        source = await fetch(`${url.replace(/\/$/, "")}/transport/pair/qr`, {
          headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
          signal: upstream.signal,
        });
      } catch (error) {
        return Response.json({ error: `the bridge could not be reached: ${error}` }, { status: 502 });
      }

      if (!source.ok || !source.body) {
        return Response.json(
          { error: `the bridge refused the pairing stream (${source.status})` },
          { status: source.status || 502 },
        );
      }

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const reader = source.body.getReader();

      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          for (const line of decoder.decode(value, { stream: true }).split("\n")) {
            const payload = /^data:\s?(.*)$/.exec(line.trim())?.[1];
            if (payload === undefined || payload === "") continue;

            // whatsmeow's stream carries lifecycle events as well as codes.
            // "success" means the phone accepted the link, which is the moment
            // the page should stop drawing and re-read its gates.
            if (payload === "success" || payload === "timeout") {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ paired: payload === "success" })}\n\n`),
              );
              continue;
            }

            try {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ matrix: qrMatrix(payload) })}\n\n`),
              );
            } catch (error) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`,
                ),
              );
            }
          }
        },
        cancel() {
          upstream.abort();
          void reader.cancel();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    }),

    /* ── preferences ───────────────────────────────────────────────── */

    GET("/ui/api/preferences", (request) => guarded(request, () => preferencesScreen(deps))),

    POST("/ui/api/preferences", (request) =>
      guarded(request, async () => {
        const updates = await body<Record<string, string>>(request);
        if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
          throw new UiError("expected an object of key/value pairs", 400);
        }
        return savePreferences(deps, updates);
      }),
    ),

    /* ── tools ─────────────────────────────────────────────────────── */

    GET("/ui/api/tools", (request) => guarded(request, async () => toolsScreen(deps))),
  ],
});

/** One bridge call the typed client does not cover, kept in one place. */
async function callBridge(path: string, payload: unknown): Promise<unknown> {
  const url = process.env.WA_BRIDGE_URL;
  const token = process.env.WA_BRIDGE_TOKEN;
  if (!url || !token) throw new UiError("the bridge is not configured", 503);

  const response = await fetch(`${url.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  if (!response.ok) throw new UiError(text.slice(0, 300) || `the bridge answered ${response.status}`, response.status);
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true };
  }
}
