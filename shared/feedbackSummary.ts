import type { TimelineItem } from "./protocol";

export function summarySource(items: readonly TimelineItem[], isAutoFix: (shown: string) => boolean): string | null {
  let autoTurn = false;
  let found: string | null = null;
  for (const item of items) {
    if (item.kind === "user") autoTurn = isAutoFix(item.shown ?? item.text);
    else if (item.kind === "assistant" && !autoTurn && item.text.trim()) found = item.text;
  }
  return found;
}
