// 에디터 오른쪽 가구(개요 눈금자, 미니맵, 고정 스크롤)가 같이 쓰는 배치 걸쇠와 치수 읽기. 규칙은 editorRightLayout.css.
import { EditorView } from "@codemirror/view";
import "./editorRightLayout.css";

// 이 속성이 붙은 에디터에만 오른쪽 배치 규칙(안쪽 여백, 스크롤바 크기, 찾기 위젯 위치)이 적용된다. diff 보기와 피크 안의 에디터는 건드리지 않는다.
export const rightFurniture = EditorView.editorAttributes.of({ "data-editor-right": "" });

// 세로 스크롤바가 차지하는 폭(CSS 픽셀). 스크롤러가 스크롤바 자리를 비워 두므로 offsetWidth - clientWidth 이고,
// 시스템이 오버레이 스크롤바로 그려 0 이 나오면 토큰(--size-editor-scrollbar-v)을 쓴다.
export function verticalScrollbarWidth(scroller: HTMLElement): number {
  const measured = scroller.offsetWidth - scroller.clientWidth;
  if (measured > 0) return measured;
  return parseFloat(getComputedStyle(scroller).getPropertyValue("--size-editor-scrollbar-v")) || 0;
}
