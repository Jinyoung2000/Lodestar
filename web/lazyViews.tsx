import { useEffect, useState } from "react";
import { useStore, type PrViewTab, type SideState } from "./store";

// 첫 화면에 필요 없는 큰 화면들. 별도 청크로 나뉘어 처음 열 때 불러온다.
// prefetchViews 가 첫 화면이 그려지고 한가해진 뒤 청크를 하나씩 미리 받아 두므로, 평소에는 처음 열어도 기다리지 않는다.
//
// React.lazy 와 Suspense 를 쓰지 않는 이유: 이미 받아 둔 모듈이어도 lazy 컴포넌트는 처음 그릴 때 한 번 중단(suspend)되고, React 는 fallback 이 보인 뒤
// 내용을 드러내는 시점을 약 300ms 늦춘다(FALLBACK_THROTTLE_MS). 미리 받은 화면도 열릴 때 0.35초씩 걸렸다. 여기서는 받은 컴포넌트를 모듈 변수에 두고,
// 받아 둔 뒤에는 첫 렌더에서 바로 그리고 아직이면 받는 동안 빈 화면이다.
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

// wanted 가 false 인 동안은 받지 않는다(항상 마운트되어 있는 Overlays 가 시작하자마자 청크를 받지 않게).
function useSlot<C>(entry: Slot<C>, wanted = true): C | null {
  // 렌더 중에 모듈 변수를 읽지 않고 state 로 든다. 렌더와 effect 사이에 청크가 도착해도(미리 받기) effect 가 다시 받아(캐시에서 바로 풀림) state 를 채운다.
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
const notes = slot(() => import("./NotesView").then((m) => m.NotesView));
const skills = slot(() => import("./SkillsView").then((m) => m.SkillsView)); // SKILLS
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

export function NotesView() {
  const Loaded = useSlot(notes);
  return Loaded ? <Loaded /> : null;
}

export function SkillsView() {
  const Loaded = useSlot(skills);
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

// 첫 화면이 그려진 뒤 메인 스레드가 한가할 때 청크를 하나씩 받는다. 앱 창에서만 부른다(미니 채팅, 빠른 입력창은 이 화면들을 안 쓴다).
const PREFETCH_ORDER = [overlays, terminal, settings, board, inbox, pullRequest, pullRequestTab, notion, notes, skills, improvements, sideChat];
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
