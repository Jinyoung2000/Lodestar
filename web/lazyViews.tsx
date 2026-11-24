import { useEffect, useState } from "react";
import { useStore, type PrViewTab, type SideState } from "./store";

type Slot<C> = { component: C | null; load: () => Promise<C> };

function slot<C>(importer: () => Promise<C>): Slot<C> {
  const entry: Slot<C> = {
    component: null,
    load: () =>
      importer().then((component) => {
        entry.component = component;
        return component;
      }),
  };
  return entry;
}

function useSlot<C>(entry: Slot<C>, wanted = true): C | null {
  const [Loaded, setLoaded] = useState<C | null>(() => entry.component);
  useEffect(() => {
    if (!wanted || Loaded) return;
    let alive = true;
    entry.load().then(
      (component) => alive && setLoaded(() => component),
      (error) => console.error("[agent-nav] could not load a view chunk", error),
    );
    return () => {
      alive = false;
    };
  }, [entry, wanted, Loaded]);
  return Loaded;
}

const terminal = slot(() => import("./Terminal").then((m) => m.TerminalView));
const board = slot(() => import("./Board").then((m) => m.BoardView));
const inbox = slot(() => import("./Inbox").then((m) => m.InboxView));
const improvements = slot(() => import("./Improvements").then((m) => m.ImprovementsView));
const pullRequest = slot(() => import("./PullRequestView").then((m) => m.PullRequestView));
const pullRequestTab = slot(() => import("./PullRequestView").then((m) => m.PullRequestTab));
const notion = slot(() => import("./NotionView").then((m) => m.NotionView));
const skills = slot(() => import("./SkillsView").then((m) => m.SkillsView));
const automations = slot(() => import("./AutomationsView").then((m) => m.AutomationsView));
const automationEditor = slot(() => import("./AutomationEditor").then((m) => m.AutomationEditorHost));
const sideChat = slot(() => import("./SideChat").then((m) => m.SideChat));
const settings = slot(() => import("./SettingsView").then((m) => m.SettingsView));
const overlays = slot(() => import("./Overlays").then((m) => m.Overlays));

export function TerminalView({ scopeKey, params, active, onExit }: { scopeKey: string; params: Record<string, string>; active: boolean; onExit: () => void }) {
  const Loaded = useSlot(terminal);
  return Loaded ? <Loaded scopeKey={scopeKey} params={params} active={active} onExit={onExit} /> : null;
}

export function BoardView() {
  const Loaded = useSlot(board);
  return Loaded ? <Loaded /> : null;
}

export function InboxView() {
  const Loaded = useSlot(inbox);
  return Loaded ? <Loaded /> : null;
}

export function ImprovementsView() {
  const Loaded = useSlot(improvements);
  return Loaded ? <Loaded /> : null;
}

export function PullRequestView() {
  const Loaded = useSlot(pullRequest);
  return Loaded ? <Loaded /> : null;
}

export function PullRequestTab({ tab, active }: { tab: PrViewTab; active: boolean }) {
  const Loaded = useSlot(pullRequestTab);
  return Loaded ? <Loaded tab={tab} active={active} /> : null;
}

export function NotionView() {
  const Loaded = useSlot(notion);
  return Loaded ? <Loaded /> : null;
}

export function SkillsView() {
  const Loaded = useSlot(skills);
  return Loaded ? <Loaded /> : null;
}

export function AutomationsView() {
  const Loaded = useSlot(automations);
  return Loaded ? <Loaded /> : null;
}

export function AutomationEditorHost() {
  const wanted = useStore((s) => s.automationEditor !== null);
  const Loaded = useSlot(automationEditor, wanted);
  return Loaded ? <Loaded /> : null;
}

export function SideChat({ side }: { side: SideState }) {
  const Loaded = useSlot(sideChat);
  return Loaded ? <Loaded side={side} /> : null;
}

export function SettingsView() {
  const Loaded = useSlot(settings);
  return Loaded ? <Loaded /> : null;
}

export function Overlays() {
  const overlay = useStore((s) => s.overlay);
  const Loaded = useSlot(overlays, overlay !== null);
  return Loaded ? <Loaded /> : null;
}

const PREFETCH_ORDER = [overlays, terminal, settings, board, inbox, pullRequest, pullRequestTab, notion, skills, improvements, sideChat];
const PREFETCH_DELAY_MS = 1500;

export function prefetchViews() {
  let next = 0;
  const step = () => {
    const entry = PREFETCH_ORDER[next++];
    if (!entry) return;
    entry.load().catch(() => undefined);
    schedule();
  };
  const schedule = () => {
    if (next >= PREFETCH_ORDER.length) return;
    if (window.requestIdleCallback) window.requestIdleCallback(step, { timeout: 4000 });
    else setTimeout(step, 100);
  };
  setTimeout(schedule, PREFETCH_DELAY_MS);
}
