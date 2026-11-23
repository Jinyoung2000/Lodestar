import { getState, subscribe } from "./store";

const NAME = "quote-comment";
const ranges = new Map<string, Range>();
let unsubscribe: (() => void) | null = null;

function paint() {
  if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
  const live = new Set(Object.values(getState().attachments).flatMap((list) => list.filter((a) => a.quote).map((a) => a.id)));
  for (const id of ranges.keys()) if (!live.has(id)) ranges.delete(id);
  if (ranges.size) CSS.highlights.set(NAME, new Highlight(...ranges.values()));
  else CSS.highlights.delete(NAME);
  if (!ranges.size && unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

export function markQuoteRange(id: string, range: Range) {
  ranges.set(id, range);
  unsubscribe ??= subscribe(paint);
  paint();
}
