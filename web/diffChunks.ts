import type { Text } from "@codemirror/state";

export type ChunkRange = { fromA: number; toA: number; fromB: number; toB: number };
export type ChunkAction = "keep" | "undo";
export type ChunkEdit = { target: "a" | "b"; from: number; to: number; insert: string };

export function chunkEdit(chunk: ChunkRange, a: Text, b: Text, action: ChunkAction, lineBreak = "\n"): ChunkEdit {
  const [source, dest, srcFrom, srcTo, destFrom, destTo, target] =
    action === "keep" ? ([b, a, chunk.fromB, chunk.toB, chunk.fromA, chunk.toA, "a"] as const) : ([a, b, chunk.fromA, chunk.toA, chunk.fromB, chunk.toB, "b"] as const);
  let insert = source.sliceString(srcFrom, Math.max(srcFrom, srcTo - 1));
  if (srcFrom !== srcTo && destTo <= dest.length) insert += lineBreak;
  return { target, from: destFrom, to: Math.min(dest.length, destTo), insert };
}

export function revertedNewFile(state: { baseMissing: boolean; reverted: boolean; original: string; text: string }) {
  return state.baseMissing && state.reverted && state.original === "" && state.text === "";
}
