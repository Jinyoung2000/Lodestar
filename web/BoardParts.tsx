import type { ReactNode } from "react";
import { LABEL_COLORS, labelColorOf } from "../shared/board";
import type { BoardPriority, BoardRole } from "../shared/protocol";
import { useStore } from "./store";
import { S } from "./strings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Close } from "./icons";

// BOARDUX: 보드와 카드 상세가 같이 쓰는 작은 부품. 색은 전부 tokens.json 의 status-*, priority-*, label-* 토큰이고, 정보가 있을 때만 쓴다.

// 메뉴나 선택 목록을 Esc 로 닫을 때 같은 키가 앱의 전역 Esc(보드 닫기)까지 가지 않게 한다. 보드 안의 Radix 메뉴와 Select 의 onEscapeKeyDown 에 넘긴다.
export const stopEscape = (event: KeyboardEvent) => event.stopPropagation();

// 열의 역할(상태)을 나타내는 원 아이콘. Backlog 점선 원, Todo 빈 원, In Progress 반 찬 원, Review 4분의 3 찬 원, Done 체크 원, 역할 없는 열은 가운데 점이 있는 원.
export function StatusIcon({ role, size = 14 }: { role: BoardRole | null; size?: number }) {
  return (
    <svg className="status-icon" data-role={role ?? "custom"} width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <StatusShape role={role} />
    </svg>
  );
}

function StatusShape({ role }: { role: BoardRole | null }) {
  if (role === "backlog") return <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2.2" />;
  if (role === "todo") return <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.5" />;
  if (role === "inProgress") {
    return (
      <>
        <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7 3.75A3.25 3.25 0 0 1 7 10.25Z" fill="currentColor" />
      </>
    );
  }
  if (role === "review") {
    return (
      <>
        <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7 7V3.75A3.25 3.25 0 1 1 3.75 7Z" fill="currentColor" />
      </>
    );
  }
  if (role === "done") {
    return (
      <>
        <circle cx="7" cy="7" r="6.5" fill="currentColor" />
        <path d="M4.3 7.2 6.2 9l3.5-3.7" stroke="var(--surface-base)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  }
  return (
    <>
      <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="1.5" fill="currentColor" />
    </>
  );
}

// 우선순위 아이콘 (Linear 와 같은 모양). Urgent 는 경고색 사각형에 느낌표, High, Medium, Low 는 회색 막대 세 칸 중 3, 2, 1 칸, 없음은 흐린 점선 세 개.
export function PriorityIcon({ priority, size = 14 }: { priority: BoardPriority; size?: number }) {
  return (
    <svg className="priority-icon" data-priority={priority} width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <PriorityShape priority={priority} />
    </svg>
  );
}

function PriorityShape({ priority }: { priority: BoardPriority }) {
  if (priority === 0) {
    return (
      <>
        <rect x="1.5" y="6.25" width="3" height="1.5" rx="0.75" fill="var(--priority-bar-off)" />
        <rect x="5.5" y="6.25" width="3" height="1.5" rx="0.75" fill="var(--priority-bar-off)" />
        <rect x="9.5" y="6.25" width="3" height="1.5" rx="0.75" fill="var(--priority-bar-off)" />
      </>
    );
  }
  if (priority === 1) {
    return (
      <>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="var(--priority-urgent)" />
        <rect x="6.25" y="3.5" width="1.5" height="4.5" rx="0.75" fill="var(--surface-base)" />
        <circle cx="7" cy="10" r="0.9" fill="var(--surface-base)" />
      </>
    );
  }
  const filled = 5 - priority;
  return (
    <>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={2 + i * 4} y={12 - (3 + i * 3)} width="2.5" height={3 + i * 3} rx="0.75" fill={i < filled ? "var(--priority-bar)" : "var(--priority-bar-off)"} />
      ))}
    </>
  );
}

// 작은 색 점과 글자. 색은 라벨 이름으로 정해지고(같은 이름은 항상 같은 색), 사용자가 고른 색이 있으면 그것이다.
export function LabelChip({ label, children }: { label: string; children?: ReactNode }) {
  const colors = useStore((s) => s.board?.labelColors);
  return (
    <span className="label-chip" data-color={labelColorOf(colors, label)}>
      <span className="label-dot" aria-hidden="true" />
      <span className="label-chip-text">{label}</span>
      {children}
    </span>
  );
}

// 카드 상세의 라벨 칩. 점을 누르면 팔레트에서 색을 고르고, X 로 라벨을 뗀다.
export function EditableLabelChip({ label, onPick, onRemove }: { label: string; onPick: (color: number | null) => void; onRemove: () => void }) {
  const colors = useStore((s) => s.board?.labelColors);
  const color = labelColorOf(colors, label);
  const chosen = !!colors?.[label.trim().toLowerCase()];
  return (
    <span className="label-chip" data-color={color}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="label-dot-button" aria-label={S.labelColorTitle(label)} title={S.labelColorTitle(label)}>
            <span className="label-dot" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onEscapeKeyDown={stopEscape}>
          <DropdownMenuRadioGroup value={chosen ? String(color) : ""} onValueChange={(value) => onPick(Number(value))}>
            {Array.from({ length: LABEL_COLORS }, (_, i) => (
              <DropdownMenuRadioItem key={i} value={String(i)}>
                <span className="label-dot" data-color={i} aria-hidden="true" />
                {S.labelColorNames[i]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!chosen} onSelect={() => onPick(null)}>
            {S.labelColorReset}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="label-chip-text">{label}</span>
      <button type="button" className="label-remove" aria-label={S.removeLabel(label)} onClick={onRemove}>
        <Close size={12} />
      </button>
    </span>
  );
}
