import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { version as APP_VERSION } from "../package.json";
import { PREVIEW_FRAME_WIDTH, PREVIEW_HTML_MAX_CHARS, PREVIEW_MAX_FRAMES, PREVIEW_SERVER, PREVIEW_TOOL_NAME } from "../shared/previewCard";

const DESCRIPTION = [
  "Show rendered HTML right inside the chat, so the user sees a UI change without opening a file.",
  `Use it whenever you change or propose a screen: send the current screen as the first frame labeled "As-is" and the changed screen as "To-be", or up to ${PREVIEW_MAX_FRAMES} frames to compare.`,
  `Each frame renders at ${PREVIEW_FRAME_WIDTH}px wide, like a phone, with scripts and network requests blocked: inline all CSS, and embed images as data: URLs or use https URLs.`,
  "Recreate only the part of the screen that changed, using the app's real colors, fonts and spacing, so the two frames differ only where the change is.",
  "To let the user pick between options, call AskUserQuestion instead and put each option's HTML in its preview field; Lodestar renders those previews the same way.",
].join(" ");

export function previewToolServer() {
  return createSdkMcpServer({
    name: PREVIEW_SERVER,
    version: APP_VERSION,
    tools: [
      tool(
        PREVIEW_TOOL_NAME,
        DESCRIPTION,
        {
          title: z.string().optional().describe("One short line above the frames, for example what changed."),
          frames: z
            .array(
              z.object({
                label: z.string().describe('Short label shown above the frame, for example "As-is" or "To-be".'),
                html: z.string().max(PREVIEW_HTML_MAX_CHARS).describe("A self-contained HTML fragment or document with inline styles."),
              }),
            )
            .min(1)
            .max(PREVIEW_MAX_FRAMES),
        },
        async (args) => ({ content: [{ type: "text", text: `Shown to the user in the chat (${args.frames.length} frame${args.frames.length === 1 ? "" : "s"}).` }] }),
      ),
    ],
  });
}
