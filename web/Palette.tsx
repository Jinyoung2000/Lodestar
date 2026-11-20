import type { KeyboardEvent } from "react";
import { setState } from "./store";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

export function Palette({
  label,
  placeholder,
  query,
  onQuery,
  onKeyDown,
  footer,
  quickpick = false,
  count = null,
  customButton = null,
  title = null,
  busy = false,
  onClose,
  listboxId,
  activeOptionId,
  dialogClassName,
  children,
}: {
  label: string;
  placeholder: string;
  query: string;
  onQuery: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  footer: string | null;
  quickpick?: boolean;
  count?: string | null;
  customButton?: { label: string; onClick: () => void } | null;
  title?: string | null;
  // 기다리는 중이면 위에 진행 막대를 보인다(기기 요청처럼 목록이 아직 바뀔 수 있을 때)
  busy?: boolean;
  // 닫힐 때(Esc, 바깥 누르기) 할 일. 없으면 overlay 를 비운다.
  onClose?: () => void;
  // 목록이 listbox 일 때: 입력이 combobox 로 그 목록과 활성 행을 가리킨다(낭독기가 고른 행을 읽는다)
  listboxId?: string;
  activeOptionId?: string;
  dialogClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && (onClose ? onClose() : setState({ overlay: null }))}>
      <DialogContent label={label} className={[quickpick ? "palette-quickpick" : "", dialogClassName ?? ""].filter(Boolean).join(" ") || undefined} overlayClassName={quickpick ? "bg-transparent" : undefined}>
        {title && <div className="quickpick-title-bar">{title}</div>}
        {busy && <div className="quickpick-progress" role="progressbar" aria-label={title ?? label} />}
        <div className="palette-input">
          <input
            className={quickpick ? "input" : "input mono"}
            aria-label={label}
            placeholder={placeholder}
            autoFocus
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onKeyDown}
            {...(listboxId ? { role: "combobox", "aria-expanded": true, "aria-controls": listboxId, "aria-activedescendant": activeOptionId } : {})}
          />
        </div>
        {count && (
          <span className="sr-only" role="status" data-quickpick-count>
            {count}
          </span>
        )}
        <div className="palette-list">{children}</div>
        {footer && <div className="palette-footer">{footer}</div>}
        {customButton && (
          <div className="palette-custom-button">
            <Button variant="primary" size="sm" onClick={customButton.onClick}>
              {customButton.label}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
