import { ChangesBadge } from "./ChangesBadge";
import { Codicon } from "./icons";
import { pressActivity } from "./focusLayout";
import { sideKeyOf } from "./floatLayout";
import { getState, setFocusView, setState, useStore } from "./store";
import { S } from "./strings";
import "./focusLayout.css";

export function ActivityBar() {
  const open = useStore((s) => s.focusSideOpen);
  const view = useStore((s) => sideKeyOf(s.sideTabKey, !!s.selectedCardId));
  const hasCard = useStore((s) => !!s.selectedCardId);
  return (
    <nav className="activity-bar" aria-label={S.activityBarAria}>
      <div className="activity-group">
        <ViewButton view="files" icon="files" label={S.activityExplorer} open={open} current={view} />
        <ViewButton view="changes" icon="diff-multiple" label={S.activityChanges} open={open} current={view}>
          <ChangesBadge />
        </ViewButton>
        <ViewButton view="scm" icon="source-control" label={S.activityScm} open={open} current={view} />
        <ViewButton view="search" icon="search" label={S.activitySearch} open={open} current={view} />
        {hasCard && <ViewButton view="card" icon="project" label={S.activityCard} open={open} current={view} />}
      </div>
      <div className="activity-group">
        <button type="button" className="activity-item" aria-label={S.activitySessions} title={S.activitySessions} onClick={() => setState({ overlay: { kind: "sessions" } })}>
          <Codicon name="comment-discussion" />
        </button>
      </div>
    </nav>
  );
}

function ViewButton({ view, icon, label, open, current, children }: { view: string; icon: string; label: string; open: boolean; current: string; children?: React.ReactNode }) {
  const pressed = open && current === view;
  return (
    <button
      type="button"
      className="activity-item"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-view={view}
      onClick={() => {
        const s = getState();
        const next = pressActivity(s.focusSideOpen, sideKeyOf(s.sideTabKey, !!s.selectedCardId), view);
        setFocusView(next.view, next.open);
      }}
    >
      <Codicon name={icon} />
      {children}
    </button>
  );
}
