import { useLayoutEffect, useRef } from "react";
import { useSessionDrag, type SessionDrag } from "./sessionDrag";

const CHIP_OFFSET = 12;

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
