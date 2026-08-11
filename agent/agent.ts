import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

export default defineAgent({
  // Direct provider model: reads ANTHROPIC_API_KEY from the environment.
  // The native id format uses hyphens, unlike the gateway's "anthropic/claude-sonnet-5".
  model: anthropic("claude-sonnet-5"),
});
