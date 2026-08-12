import { defineMcpClientConnection } from "eve/connections";

/**
 * FrameForge: author a document with a Python SDK, render it, inspect the pixels.
 *
 * ── Why this needed plumbing rather than a line of config ───────────────────
 * FrameForge ships an MCP server that speaks stdio, which suits a client that
 * can spawn a subprocess. eve cannot: an MCP connection here is a URL, and the
 * URL must speak Streamable HTTP or SSE. `scripts/frameforge-http.py` asks
 * FastMCP — which FrameForge already depends on — for its HTTP transport, and
 * does nothing else; FrameForge itself is unpatched.
 *
 * ── Why the address is a compose service ────────────────────────────────────
 * The renderer runs as its own container (`docker compose --profile frameforge
 * up`), for a reason that is not tidiness: **delivery**. A render is a file, and
 * `whatsapp_deliver_render` sends the file. The service and this agent mount one
 * volume, so a page written to /work/sessions/<id>/ is a page this agent can
 * read and put on the user's phone. A server run on the host writes into the
 * host's temp directory instead — reachable by nobody in here, so everything
 * renders and nothing can be delivered.
 *
 * ── No auth, and why that is a considered choice rather than an omission ────
 * FrameForge's own capability report says its code execution is
 * `"sandboxed": false`, so the exposure question is real. The answer is that the
 * service publishes no port at all: it is reachable only from this compose
 * network, which is a narrower surface than any credential would buy on a bound
 * host port. Point `WA_FRAMEFORGE_MCP_URL` somewhere else — a host-run server on
 * the compose gateway, say — and that reasoning no longer holds: give it a token
 * first, and mount its session root here or delivery will not work.
 *
 * ── Why so few tools ────────────────────────────────────────────────────────
 * FrameForge ships thirty-five, most of them a computer-vision lane for turning
 * screenshots back into vectors. None of that belongs in a messaging assistant's
 * context window. What is left is: look up the model, author, render, verify,
 * read an artifact. Adding a name here is a deliberate act, not a default.
 */
export default defineMcpClientConnection({
  url: process.env.WA_FRAMEFORGE_MCP_URL?.trim() || "http://frameforge:8110/mcp",

  description:
    "FrameForge: render documents, diagrams, decks and images from a Python SDK, then measure the " +
    "result. Use it to PRODUCE a page (a poster, a one-pager, a card, a chart, a diagram) or to " +
    "inspect one (read what a render actually drew). Call describe_capabilities first to look up " +
    "types and fields rather than guessing at them, and deliver the finished page to WhatsApp with " +
    "whatsapp_deliver_render.",

  tools: {
    allow: [
      // Look it up instead of guessing: the model surface is introspected live.
      "describe_capabilities",
      "get_guide",
      // A font family that does not resolve is substituted silently.
      "list_fonts",
      "fit_text",
      // Author and render.
      "run_sdk_code",
      "render_frameforge_yaml",
      // Verify: the report behind the render's own diagnostics.
      "design_audit",
      // Read back an artifact — diagnostics, the generated YAML.
      "get_session_resource",
      // Housekeeping on a scratch directory that is shared with this agent.
      "list_sessions",
      "cleanup_sessions",
      // Retired spellings are a rewrite, not a debugging session.
      "list_deprecated_forms",
      "migrate_deprecated_forms",
    ],
  },
});
