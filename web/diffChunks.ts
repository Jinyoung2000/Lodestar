import type { Text } from "@codemirror/state";

// 덩어리 하나를 처리할 때 어느 문서의 어느 구간을 무엇으로 바꾸는지. DOM 이 없어서 노드에서 시험할 수 있다.
// @codemirror/merge 의 acceptChunk(inline 의 Keep)와 rejectChunk(inline 의 Undo)가 쓰는 계산과 같고, split 의 Keep 과 Undo 가 이 함수를 쓴다.
export type ChunkRange = { fromA: number; toA: number; fromB: number; toB: number };
export type ChunkAction = "keep" | "undo";
export type ChunkEdit = { target: "a" | "b"; from: number; to: number; insert: string };

// a 는 기준 문서, b 는 현재 문서.
//  - keep: 기준(a)의 이 구간을 현재(b)의 덩어리 내용으로 바꾼다. 기준이 덩어리만큼 앞으로 간다.
//  - undo: 현재(b)의 이 구간을 기준(a)의 덩어리 내용으로 바꾼다. 파일이 덩어리만큼 수정 전으로 돌아간다.
export function chunkEdit(chunk: ChunkRange, a: Text, b: Text, action: ChunkAction, lineBreak = "\n"): ChunkEdit {
  const [source, dest, srcFrom, srcTo, destFrom, destTo, target] =
    action === "keep" ? ([b, a, chunk.fromB, chunk.toB, chunk.fromA, chunk.toA, "a"] as const) : ([a, b, chunk.fromA, chunk.toA, chunk.fromB, chunk.toB, "b"] as const);
  let insert = source.sliceString(srcFrom, Math.max(srcFrom, srcTo - 1));
  // 덩어리 마지막 줄의 줄바꿈은 구간 밖이라 따로 붙인다. 기준 쪽 구간이 문서 끝을 넘어가 있으면(끝 줄 뒤) 붙이지 않는다.
  if (srcFrom !== srcTo && destTo <= dest.length) insert += lineBreak;
  return { target, from: destFrom, to: Math.min(dest.length, destTo), insert };
}

export function revertedNewFile(state: { baseMissing: boolean; reverted: boolean; original: string; text: string }) {
  return state.baseMissing && state.reverted && state.original === "" && state.text === "";
}
