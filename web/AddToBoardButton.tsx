import { useMemo } from "react";
import { findSourceCard } from "../shared/toBoard";
import { BoardIcon } from "./icons";
import { useStore } from "./store";
import { S } from "./strings";
import { canAddToBoard, openToBoard } from "./toBoardState";

// 대화의 한 줄에 붙는 "Add to Board" 단추. 누르면 제목과 열을 고르는 팝오버(web/ToBoardPopover.tsx)가 뜨고, 이미 카드가 있는 부분이면 단추가 켜진 모양이 되어 그 카드를 열지 묻는다.
// 답 아래 줄, 사용자 말풍선 모서리, 할 일 한 줄이 같이 쓴다. 모양(className, size)은 놓이는 줄이 정한다.
export function AddToBoardButton({ agentId, itemId, text, part, kind, className, size }: { agentId: string; itemId: string; text: string; part: string | null; kind: "response" | "message" | "task"; className: string; size?: number }) {
  // 보드만 구독하고 카드 찾기는 보드가 바뀔 때만 한다. 선택자 안에서 찾으면 다른 세션의 스트리밍 이벤트마다 단추 수 × 카드 수만큼 훑는다(PERF2).
  const board = useStore((s) => s.board);
  const linked = useMemo(() => findSourceCard(board, { agentId, itemId, part }), [board, agentId, itemId, part]);
  if (!canAddToBoard()) return null;
  const tip = linked ? S.toBoardLinkedTip : kind === "response" ? S.toBoardResponseTip : kind === "task" ? S.toBoardTaskTip : S.toBoardMessageTip;
  return (
    <button
      type="button"
      className={className}
      data-on={linked ? "" : undefined}
      data-action="add-to-board"
      aria-label={tip}
      title={tip}
      onClick={(event) => {
        const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect();
        openToBoard({ agentId, itemId, text, part, rect: { left, top, right, bottom }, trigger: event.currentTarget });
      }}
    >
      <BoardIcon size={size} />
    </button>
  );
}
