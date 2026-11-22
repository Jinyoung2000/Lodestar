import { useMemo } from "react";
import { findSourceCard } from "../shared/toBoard";
import { BoardIcon } from "./icons";
import { useStore } from "./store";
import { S } from "./strings";
import { canAddToBoard, openToBoard } from "./toBoardState";

export function AddToBoardButton({ agentId, itemId, text, part, kind, className, size }: { agentId: string; itemId: string; text: string; part: string | null; kind: "response" | "message" | "task"; className: string; size?: number }) {
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
