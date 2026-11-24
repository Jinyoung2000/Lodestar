export const PREVIEW_SERVER = "lodestar_ui";
export const PREVIEW_TOOL_NAME = "show_preview";
export const PREVIEW_TOOL = `mcp__${PREVIEW_SERVER}__${PREVIEW_TOOL_NAME}`;
export const PREVIEW_MAX_FRAMES = 4;
export const PREVIEW_HTML_MAX_CHARS = 100_000;
export const PREVIEW_FRAME_WIDTH = 390;

export type PreviewFrame = { label: string; html: string };
export type PreviewCard = { title: string; frames: PreviewFrame[] };

export const isPreviewTool = (name: string) => name === PREVIEW_TOOL;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function readPreviewCard(input: Record<string, unknown> | null | undefined): PreviewCard | null {
  const list = Array.isArray(input?.frames) ? input.frames : [];
  const frames = list.slice(0, PREVIEW_MAX_FRAMES).flatMap((raw): PreviewFrame[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const html = (raw as Record<string, unknown>).html;
    if (typeof html !== "string" || !html.trim()) return [];
    return [{ label: text((raw as Record<string, unknown>).label), html }];
  });
  return frames.length ? { title: text(input?.title), frames } : null;
}

export const looksLikeHtml = (value: string) => /^\s*</.test(value) && /<\/?[a-z][\s\S]*>/i.test(value);

const FRAME_POLICY = "default-src 'none'; img-src data: https:; media-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com";

export function previewFrameDocument(html: string, background: string): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}">`,
    `<meta name="viewport" content="width=${PREVIEW_FRAME_WIDTH}, initial-scale=1">`,
    `<style>html,body{margin:0;background:${background};-webkit-text-size-adjust:100%}body{display:flow-root}</style>`,
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}
