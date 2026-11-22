import type { DiffView } from "../shared/protocol";

export const SPLIT_MIN_PANE = 320;
export const SPLIT_GAP = 28;

export const splitFits = (hostWidth: number) => hostWidth >= SPLIT_MIN_PANE * 2 + SPLIT_GAP;

export function chooseDiffMode(requested: DiffView, hostWidth: number | null, autoInline: boolean): { mode: "inline" | "split"; tooNarrow: boolean } {
  const tooNarrow = requested === "split" && autoInline && hostWidth !== null && !splitFits(hostWidth);
  const split = (requested === "split" && !tooNarrow) || (requested === "auto" && hostWidth !== null && splitFits(hostWidth));
  return { mode: split ? "split" : "inline", tooNarrow };
}
