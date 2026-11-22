import { Branch, CircleFilled, CircleSmallFilled, Codicon, DotSpinner } from "./icons";
import { pickSessionSwitcherRow, useSessionSwitcher } from "./sessionSwitcher";
import type { SwitcherSession } from "./sessionSwitcherModel";
import { S } from "./strings";
import "./sessionSwitcher.css";

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
