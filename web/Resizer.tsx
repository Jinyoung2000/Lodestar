import { useState } from "react";
import { perfCount } from "./perfCounter";
import { beginResize, dragSize, endResize } from "./resizeDrag";

export function Resizer({ axis, label, target, direction, min, max, onSize, hidden, className }: { axis: "x" | "y"; label: string; target: string; direction: 1 | -1; min: number; max: () => number; onSize: (px: number | null) => void; hidden?: boolean; className?: string }) {
  const [active, setActive] = useState(false);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = document.querySelector<HTMLElement>(target);
    if (!el || event.button !== 0) return;
    const rect = el.getBoundingClientRect();
    const startSize = axis === "x" ? rect.width : rect.height;
    const startPos = axis === "x" ? event.clientX : event.clientY;
    const limit = max();
    const property = axis === "x" ? "width" : "height";
    // React 가 준 인라인 값. 놓을 때 이 값으로 되돌리고 최종 크기는 onSize 가 store 를 거쳐 다시 그리게 한다.
    const before = el.style[property];
    // flex 아이템이 flex-basis 로 크기를 받으면(예: `flex: 0 0 var(--pinned-w)`) 인라인 width 는 무시되므로 flex-basis 도 같이 쓴다.
    const basis = usesFlexBasis(el, axis);
    const basisBefore = el.style.flexBasis;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 합성 PointerEvent(검증 창구)는 활성 포인터가 아니라 캡처가 거절된다. window 리스너로 끝까지 따라가므로 없어도 된다.
    }
    setActive(true);
    beginResize();
    let wanted: number | null = null;
    let applied: number | null = null;
    let frame = 0;
    const apply = () => {
      frame = 0;
      if (wanted === null || wanted === applied) return;
      perfCount("resize.apply");
      el.style[property] = `${wanted}px`;
      if (basis) el.style.flexBasis = `${wanted}px`;
      applied = wanted;
    };
    const move = (e: PointerEvent) => {
      perfCount("resize.move");
      const pos = axis === "x" ? e.clientX : e.clientY;
      wanted = dragSize(startSize, pos - startPos, direction, min, limit);
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      cancelAnimationFrame(frame);
      el.style[property] = before;
      if (basis) el.style.flexBasis = basisBefore;
      setActive(false);
      endResize();
      if (wanted === null) return;
      perfCount("resize.onSize");
      onSize(wanted);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  return <div className={className ? `resizer ${className}` : "resizer"} role="separator" aria-label={label} aria-orientation={axis === "x" ? "vertical" : "horizontal"} data-axis={axis} data-active={active || undefined} hidden={hidden} onPointerDown={onPointerDown} onDoubleClick={() => onSize(null)} />;
}

// 대상이 flex 컨테이너의 아이템이고 flex-basis 가 auto 가 아니며 컨테이너 방향이 끄는 축과 같으면 true. 이때 크기는 flex-basis 가 정한다.
function usesFlexBasis(el: HTMLElement, axis: "x" | "y"): boolean {
  const parent = el.parentElement;
  if (!parent) return false;
  const container = getComputedStyle(parent);
  if (container.display !== "flex" && container.display !== "inline-flex") return false;
  const row = container.flexDirection.startsWith("row");
  if (row !== (axis === "x")) return false;
  const basis = getComputedStyle(el).flexBasis;
  return basis !== "auto" && basis !== "content";
}
