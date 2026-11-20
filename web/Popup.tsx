import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

// 입력창 둘레의 작은 목록 팝업(모델, 생각 수준, 권한, 첨부, `/` 와 `@`). 기준 요소 위나 아래에 붙고, 바깥을 누르거나 Esc 를 누르면 닫힌다.
// 위치를 잡기 전 한 프레임은 투명하게 둔다(visibility 로 숨기면 autoFocus 가 먹지 않는다). 포털로 body 에 그려서 칸의 overflow 에 잘리지 않는다. 기준 요소가 없으면(단축키로 열렸는데 입력창이 화면에 없을 때) 화면 위쪽 가운데에 뜬다.
export type PopupProps = {
  anchor: HTMLElement | null;
  placement?: "above" | "below";
  align?: "start" | "end";
  onClose: () => void;
  // 포커스가 입력창에 남는 메뉴(`/`, `@`)는 Esc 를 입력창이 받는다
  closeOnEscape?: boolean;
  // 기준 요소의 폭에 맞춘다(`/` 와 `@` 목록은 입력창 폭)
  matchWidth?: boolean;
  className?: string;
  label: string;
  children: ReactNode;
};

const GAP = 4;
const MARGIN = 8;

export function Popup({ anchor, placement = "above", align = "start", onClose, closeOnEscape = true, matchWidth = false, className, label, children }: PopupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0 });
  // 열기 전에 포커스가 있던 요소(입력창, 칩). 팝업 안의 검색칸이 autoFocus 로 포커스를 가져가기 전, 처음 그릴 때 읽는다.
  const [opener] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  // 닫히며 포커스가 팝업과 함께 사라지면(body 로 떨어지면) 연 자리로 돌려준다. 단축키로 모델을 고른 뒤 이어 쓰는 글이 입력창에 들어간다.
  useEffect(
    () => () => {
      const now = document.activeElement;
      if (!opener || opener === document.body || !opener.isConnected) return;
      if (!now || now === document.body || ref.current?.contains(now)) opener.focus({ preventScroll: true });
    },
    [opener],
  );

  useLayoutEffect(() => {
    const place = () => {
      if (!anchor) {
        setStyle({});
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const next: CSSProperties = align === "end" ? { right: window.innerWidth - rect.right } : { left: Math.max(MARGIN, rect.left) };
      if (matchWidth) next.width = rect.width;
      if (placement === "above") {
        next.bottom = window.innerHeight - rect.top + GAP;
        next.maxHeight = Math.max(rect.top - GAP - MARGIN, 0);
      } else {
        next.top = rect.bottom + GAP;
        next.maxHeight = Math.max(window.innerHeight - rect.bottom - GAP - MARGIN, 0);
      }
      setStyle(next);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, placement, align, matchWidth]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && closeOnEscape) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchor, onClose, closeOnEscape]);

  return createPortal(
    <div ref={ref} className={`popup${className ? ` ${className}` : ""}`} data-floating={anchor ? undefined : ""} role="dialog" aria-label={label} style={style}>
      {children}
    </div>,
    document.body,
  );
}

// 활성 칸 안의 요소 하나(칩 같은). 단축키로 팝업을 열 때 붙일 자리를 찾는다.
export function anchorInActivePane(selector: string, paneId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"] ${selector}`);
}
