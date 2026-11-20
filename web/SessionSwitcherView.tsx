import { Branch, CircleFilled, CircleSmallFilled, Codicon, DotSpinner } from "./icons";
import { pickSessionSwitcherRow, useSessionSwitcher } from "./sessionSwitcher";
import type { SwitcherSession } from "./sessionSwitcherModel";
import { S } from "./strings";
import "./sessionSwitcher.css";

// ⌃Tab 세션 전환 창(web/sessionSwitcher.ts). 최근에 포커스를 둔 순서의 세션 목록이고 입력 상자는 없다.
// 행: 상태 점(사이드바와 같은 모양), 제목, 흐린 폴더 이름, worktree 세션이면 브랜치. 열린 직후 잠깐은 그리지 않는다(빠르게 눌렀다 떼면 창 없이 넘어간다).
export function SessionSwitcherView() {
  const open = useSessionSwitcher();
  if (!open || !open.visible) return null;
  return (
    <div className="session-switcher" role="listbox" aria-label={S.sessionSwitcherAria} data-testid="session-switcher" data-session-switcher="">
      <div className="session-switcher-list">
        {open.rows.map((row, index) => (
          <SwitcherEntry key={row.id} row={row} selected={index === open.index} onPick={() => pickSessionSwitcherRow(index)} />
        ))}
      </div>
    </div>
  );
}

function SwitcherEntry({ row, selected, onPick }: { row: SwitcherSession; selected: boolean; onPick: () => void }) {
  return (
    <div role="option" aria-selected={selected} className="session-switcher-row" data-selected={selected || undefined} data-id={row.id} data-current={row.current || undefined} onMouseDown={(e) => e.preventDefault()} onClick={onPick}>
      <span className="session-switcher-status">
        <EntryStatus row={row} />
      </span>
      <span className="session-switcher-title">{row.title}</span>
      <span className="session-switcher-folder">{row.folder}</span>
      {row.branch && (
        <span className="session-switcher-branch">
          <Branch size={12} />
          <span className="session-switcher-branch-name">{row.branch}</span>
        </span>
      )}
      {row.current && <span className="session-switcher-aux">{S.sessionSwitcherCurrent}</span>}
    </div>
  );
}

// 사이드바 행의 상태 점과 같은 규칙: 실행 중과 승인 대기는 스피너, 오류, 안 읽음, 그 밖.
function EntryStatus({ row }: { row: SwitcherSession }) {
  if (row.status === "running" || row.status === "waiting") return <DotSpinner state={row.status} />;
  if (row.status === "error") {
    return (
      <span className="session-dot" data-kind="error">
        <Codicon name="error" />
      </span>
    );
  }
  if (row.unread) {
    return (
      <span className="session-dot" data-kind="unread">
        <CircleFilled />
      </span>
    );
  }
  return (
    <span className="session-dot" data-kind="read">
      <CircleSmallFilled />
    </span>
  );
}
