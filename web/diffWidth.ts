import type { DiffView } from "../shared/protocol";

// diff 보기를 고르는 순수 계산. DOM 과 저장소를 건드리지 않아 단위 시험이 그대로 부른다(web/diffMode.ts 가 다시 내보낸다).
// split 은 한쪽(기준 또는 현재)이 이 폭보다 좁아지면 쓰지 않는다. 줄 번호 열과 변경 표시 열을 포함한 폭이다.
export const SPLIT_MIN_PANE = 320;
// 두 칸 사이 Keep, Undo 버튼 열의 폭. styles.css 의 .cm-merge-revert 폭(버튼 2개 + 여백 3개)과 같은 값이어야 한다.
export const SPLIT_GAP = 60;

export const splitFits = (hostWidth: number) => hostWidth >= SPLIT_MIN_PANE * 2 + SPLIT_GAP;

// 요청된 보기와 diff 칸 폭으로 실제 그릴 보기를 정한다. tooNarrow 는 split 을 골랐지만 폭이 모자라 inline 으로 그리는 경우다(헤더의 "Split needs more width").
// auto(Automatic)는 폭만 본다: 두 칸이 들어가면 split, 아니면 inline. 폭을 아직 모르면(null) inline 이다.
export function chooseDiffMode(requested: DiffView, hostWidth: number | null, autoInline: boolean): { mode: "inline" | "split"; tooNarrow: boolean } {
  const tooNarrow = requested === "split" && autoInline && hostWidth !== null && !splitFits(hostWidth);
  const split = (requested === "split" && !tooNarrow) || (requested === "auto" && hostWidth !== null && splitFits(hostWidth));
  return { mode: split ? "split" : "inline", tooNarrow };
}
