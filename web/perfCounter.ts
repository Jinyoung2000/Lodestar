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

export function perfCount(name: string) {
  if (import.meta.env.MODE !== "perf") return;
  const perf = window.__navPerf;
  if (perf) perf.counts.set(name, (perf.counts.get(name) ?? 0) + 1);
}
