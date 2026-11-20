import { useLayoutEffect, useRef } from "react";
import { useSessionDrag, type SessionDrag } from "./sessionDrag";

const CHIP_OFFSET = 12; // 커서 끝에서 칩까지(px). 화살표 모양 커서와 겹치지 않을 만큼 띄운다.

// SESSIONDRAG: 끄는 동안의 표시. 놓을 자리 미리보기(반투명 칠)와 커서 옆을 따라다니는 세션 제목 칩.
export function SessionDragOverlay() {
  const drag = useSessionDrag();
  if (!drag) return null;
  const rect = drag.target?.rect;
  return (
    <>
      {rect && <div className="session-drop-preview" data-zone={drag.target?.zone} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />}
      {drag.reorder && <div className="session-reorder-line" data-edge={drag.reorder.edge} style={{ left: drag.reorder.line.left, top: drag.reorder.line.top, width: drag.reorder.line.width, height: drag.reorder.line.height }} />}
      <DragChip drag={drag} />
    </>
  );
}

// 커서 오른쪽 아래에 두고, 창 끝에 닿으면 커서 반대쪽으로 넘겨 화면 밖으로 나가지 않게 한다.
function DragChip({ drag }: { drag: SessionDrag }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    el.style.left = `${box.right > window.innerWidth ? drag.x - CHIP_OFFSET - box.width : drag.x + CHIP_OFFSET}px`;
    el.style.top = `${box.bottom > window.innerHeight ? drag.y - CHIP_OFFSET - box.height : drag.y + CHIP_OFFSET}px`;
  }, [drag.x, drag.y]);
  return (
    <div className="session-drag-chip" ref={ref} style={{ left: drag.x + CHIP_OFFSET, top: drag.y + CHIP_OFFSET }}>
      <span className="session-drag-chip-text">{drag.label}</span>
    </div>
  );
}
