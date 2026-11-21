import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { listedViews, moveView, sanitizeActivityBar, setBadgeHidden, setViewHidden, shownViews, type ActivityBarPrefs, type ActivityView } from "../shared/activityBar";
import { ChangesBadge } from "./ChangesBadge";
import { Codicon } from "./icons";
import { pressActivity } from "./focusLayout";
import { sideKeyOf } from "./floatLayout";
import { rpc } from "./rpc";
import { getState, setFocusView, setState, useStore } from "./store";
import { S } from "./strings";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import "./focusLayout.css";
import { useCommandKey } from "./commandKeys";

const ICONS: Record<ActivityView, string> = { files: "files", changes: "diff-multiple", scm: "source-control", search: "search", card: "project" };
const DRAG_THRESHOLD = 4;

type Drag = { view: ActivityView; startX: number; moved: boolean; before: ActivityView | null; markX: number | null };
type Menu = { view: ActivityView; x: number; y: number };

function savePrefs(next: ActivityBarPrefs) {
  void rpc.call("settings.set", { activityBar: next });
}

export function ActivityBar() {
  const open = useStore((s) => s.focusSideOpen);
  const view = useStore((s) => sideKeyOf(s.sideTabKey, !!s.selectedCardId));
  const hasCard = useStore((s) => !!s.selectedCardId);
  const saved = useStore((s) => s.settings?.activityBar);
  const prefs = useMemo(() => sanitizeActivityBar(saved), [saved]);
  const labels: Record<ActivityView, string> = {
    files: S.activityExplorer(useCommandKey("showFiles")),
    changes: S.activityChanges,
    scm: S.activityScm(useCommandKey("sourceControl")),
    search: S.activitySearch(useCommandKey("findInFiles")),
    card: S.activityCard,
  };
  const sessionsKey = useCommandKey("sessions");
  const groupRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const shown = shownViews(prefs, hasCard);

  const dropAt = (clientX: number): { before: ActivityView | null; markX: number } => {
    const group = groupRef.current;
    const buttons = [...(group?.querySelectorAll<HTMLElement>("[data-view]") ?? [])];
    const left = group?.getBoundingClientRect().left ?? 0;
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return { before: button.dataset.view as ActivityView, markX: Math.max(rect.left - left, 1) };
    }
    const last = buttons.at(-1)?.getBoundingClientRect();
    return { before: null, markX: last ? last.right - left : 0 };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, item: ActivityView) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ view: item, startX: event.clientX, moved: false, before: null, markX: null });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD) return;
    const target = dropAt(event.clientX);
    setDrag({ ...drag, moved: true, before: target.before, markX: target.markX });
  };
  const activate = (item: ActivityView) => {
    const s = getState();
    const next = pressActivity(s.focusSideOpen, sideKeyOf(s.sideTabKey, !!s.selectedCardId), item);
    setFocusView(next.view, next.open);
  };
  const onPointerUp = (item: ActivityView) => {
    const current = drag;
    setDrag(null);
    if (!current) return;
    if (!current.moved) return activate(item);
    const order = moveView(prefs.order, current.view, current.before);
    if (order.join() !== prefs.order.join()) savePrefs({ ...prefs, order });
  };

  const hide = (item: ActivityView, hidden: boolean) => {
    const next = setViewHidden(prefs, item, hidden, hasCard);
    if (next === prefs) return;
    savePrefs(next);
    if (hidden && item === view) setFocusView(shownViews(next, hasCard)[0] ?? "files", open);
  };

  return (
    <nav className="activity-bar" aria-label={S.activityBarAria}>
      <div className="activity-group" ref={groupRef}>
        {shown.map((item) => (
          <ViewButton key={item} view={item} label={labels[item]} pressed={open && view === item} dragging={drag?.moved === true && drag.view === item} onPointerDown={(e) => onPointerDown(e, item)} onPointerMove={onPointerMove} onPointerUp={() => onPointerUp(item)} onActivate={() => activate(item)} onMenu={(x, y) => setMenu({ view: item, x, y })}>
            {item === "changes" && !prefs.hiddenBadges.includes("changes") && <ChangesBadge />}
          </ViewButton>
        ))}
        {drag?.moved && drag.markX !== null && <span className="activity-drop-mark" style={{ left: drag.markX }} aria-hidden="true" />}
      </div>
      <div className="activity-group">
        <button type="button" className="activity-item" aria-label={S.activitySessions(sessionsKey)} title={S.activitySessions(sessionsKey)} onClick={() => setState({ overlay: { kind: "sessions" } })}>
          <Codicon name="comment-discussion" />
        </button>
      </div>
      {menu && <ViewMenu menu={menu} prefs={prefs} hasCard={hasCard} onHide={hide} onClose={() => setMenu(null)} />}
    </nav>
  );
}

type ViewButtonProps = { view: ActivityView; label: string; pressed: boolean; dragging: boolean; onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void; onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void; onPointerUp: () => void; onActivate: () => void; onMenu: (x: number, y: number) => void; children?: ReactNode };

function ViewButton({ view, label, pressed, dragging, onPointerDown, onPointerMove, onPointerUp, onActivate, onMenu, children }: ViewButtonProps) {
  return (
    <button
      type="button"
      className="activity-item"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-view={view}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onActivate();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <Codicon name={ICONS[view]} />
      {children}
    </button>
  );
}

function ViewMenu({ menu, prefs, hasCard, onHide, onClose }: { menu: Menu; prefs: ActivityBarPrefs; hasCard: boolean; onHide: (view: ActivityView, hidden: boolean) => void; onClose: () => void }) {
  const visible = shownViews(prefs, hasCard);
  const lastVisible = visible.length === 1;
  const badgeHidden = prefs.hiddenBadges.includes(menu.view);
  return (
    <DropdownMenu open onOpenChange={(next) => !next && onClose()}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="menu-anchor" style={{ left: menu.x, top: menu.y }} tabIndex={-1} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={S.activityMenuAria} data-testid="activity-menu">
        <DropdownMenuItem disabled={lastVisible} onSelect={() => onHide(menu.view, true)}>
          {S.activityHide(S.activityViewNames[menu.view])}
        </DropdownMenuItem>
        {menu.view === "changes" && <DropdownMenuItem onSelect={() => savePrefs(setBadgeHidden(prefs, menu.view, !badgeHidden))}>{badgeHidden ? S.activityShowBadge : S.activityHideBadge}</DropdownMenuItem>}
        <DropdownMenuSeparator />
        {listedViews(prefs, hasCard).map((item) => {
          const checked = !prefs.hidden.includes(item);
          return (
            <DropdownMenuCheckboxItem key={item} checked={checked} disabled={checked && lastVisible} onCheckedChange={(on) => onHide(item, !on)}>
              {S.activityViewNames[item]}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
