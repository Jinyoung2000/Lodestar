// 성능 계측 전용: `vite build --mode perf` 로 빌드한 시험 번들에서만 동작한다. MODE 는 Vite 가 항상 문자열로 바꿔 넣어서 일반 빌드에서는 분기가 통째로 빠진다.
// react-dom 보다 먼저 읽혀야 해서 아무것도 import 하지 않는다. React 가 뜰 때 DevTools 훅 자리를 차지해 커밋마다 다시 그려진 함수 컴포넌트 이름을 센다.
export type NavPerf = {
  counts: Map<string, number>;
  commits: number;
  reset: () => void;
  top: (n?: number) => [string, number][];
  emit?: (event: unknown) => void;
  emitText?: (text: string) => void;
  getState?: () => unknown;
  actions?: { openAgent: (id: string) => void; openFile: (target: unknown) => string | null; addTerminal: (id: string) => void; setLayoutMode: (mode: string) => void; toggleBottomPanel: () => void };
  setState?: (patch: unknown) => void;
  showMessage?: (agentId: string, itemId: string) => void;
  scrollToSubagent?: (paneId: string, toolId: string) => void;
  sessionList?: { setSessionView: (patch: unknown) => void; setCollapsedGroups: (ids: string[]) => void };
};

declare global {
  interface ImportMeta {
    readonly env: { readonly MODE: string };
  }
  interface Window {
    __navPerf?: NavPerf;
  }
}

type Fiber = { tag: number; flags: number; subtreeFlags: number; type: { displayName?: string; name?: string; type?: { name?: string }; render?: { name?: string } } | null; child: Fiber | null; sibling: Fiber | null };

const PERFORMED_WORK = 1;
// FunctionComponent, ForwardRef, SimpleMemoComponent, MemoComponent
const COMPONENT_TAGS = new Set([0, 11, 14, 15]);

if (import.meta.env.MODE === "perf") {
  const perf: NavPerf = {
    counts: new Map(),
    commits: 0,
    reset: () => {
      perf.counts.clear();
      perf.commits = 0;
    },
    top: (n = 25) => [...perf.counts].sort((a, b) => b[1] - a[1]).slice(0, n),
  };
  window.__navPerf = perf;
  if (localStorage.getItem("navPerf.count") === "1") {
    const nameOf = (fiber: Fiber) => {
      const type = fiber.type;
      if (!type) return "?";
      return type.displayName || type.name || type.type?.name || type.render?.name || "anonymous";
    };
    const walk = (fiber: Fiber | null) => {
      for (let f = fiber; f; f = f.sibling) {
        if (COMPONENT_TAGS.has(f.tag) && (f.flags & PERFORMED_WORK) !== 0) {
          const name = nameOf(f);
          perf.counts.set(name, (perf.counts.get(name) ?? 0) + 1);
        }
        if (f.child && ((f.subtreeFlags & PERFORMED_WORK) !== 0 || f.tag === 3)) walk(f.child);
      }
    };
    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      onScheduleFiberRoot: () => undefined,
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
        perf.commits++;
        walk(root.current);
      },
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      checkDCE: () => undefined,
    };
  }
}

// 이름표별 호출 횟수를 센다(끌개의 이동 이벤트 수, onSize 호출 수 등). perf 빌드에서만 세고, 일반 빌드에서는 MODE 가 상수로 바뀌어 아무 일도 하지 않는다.
export function perfCount(name: string) {
  if (import.meta.env.MODE !== "perf") return;
  const perf = window.__navPerf;
  if (perf) perf.counts.set(name, (perf.counts.get(name) ?? 0) + 1);
}
