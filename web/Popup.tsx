import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type PopupProps = {
  anchor: HTMLElement | null;
  placement?: "above" | "below";
  align?: "start" | "end";
  onClose: () => void;
  closeOnEscape?: boolean;
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
  const [opener] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
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
      const width = ref.current?.offsetWidth ?? 0;
      const next: CSSProperties = align === "end" ? { right: window.innerWidth - rect.right } : { left: Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN)) };
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

export function anchorInActivePane(selector: string, paneId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"] ${selector}`);
}
