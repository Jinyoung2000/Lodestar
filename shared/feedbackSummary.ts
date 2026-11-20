import type { TimelineItem } from "./protocol";

// 피드백 반영 카드의 한 줄 요약을 뽑을 답. 검사가 떨어져 자동으로 보낸 수정 턴(isAutoFix)의 답은 건너뛴다.
// 그 답은 "npm 이 없어서 고칠 수 없습니다" 처럼 검사 실패에 대한 말이라, 다시 검사로 반영될 때 요약이 실제 변경이 아니라 그 말로 남았다(test/feedbacksummary.test.ts).
// 사람이 보낸 첫 요청과 후속 턴, 재시작 뒤 이어 가는 턴의 답이 대상이고, 그중 가장 마지막 것을 돌려준다. 없으면 null.
export function summarySource(items: readonly TimelineItem[], isAutoFix: (shown: string) => boolean): string | null {
  let autoTurn = false;
  let found: string | null = null;
  for (const item of items) {
    if (item.kind === "user") autoTurn = isAutoFix(item.shown ?? item.text);
    else if (item.kind === "assistant" && !autoTurn && item.text.trim()) found = item.text;
  }
  return found;
}
