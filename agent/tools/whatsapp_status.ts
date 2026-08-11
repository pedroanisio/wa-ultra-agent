import { defineTool } from "eve/tools";
import { z } from "zod";

import { BridgeError, bridge } from "../lib/bridge.ts";

export default defineTool({
  description:
    "Check whether the WhatsApp session is linked and ready. Call this first when any other WhatsApp tool " +
    "reports an error, so you can tell the three causes apart: the bridge is not running, the session is not " +
    "linked (the user must scan a QR code), or the page is still loading.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    try {
      const s = await bridge.status(ctx.abortSignal);
      return {
        ...s,
        whatToDo:
          s.state === "logged_in"
            ? "Ready."
            : s.state === "loading"
              ? "WhatsApp Web is still starting. Wait a few seconds and try again."
              : "Not linked. The user must open the bridge's /qr endpoint and scan the code with their phone " +
                "(WhatsApp → Settings → Linked devices → Link a device).",
      };
    } catch (error) {
      if (error instanceof BridgeError) return { state: "unreachable", error: error.message };
      throw error;
    }
  },
});
