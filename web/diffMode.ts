import { useSyncExternalStore } from "react";
import { DIFF_VIEWS, type DiffView } from "../shared/protocol";
import { rpc } from "./rpc";
import { useStore } from "./store";

export { chooseDiffMode, SPLIT_GAP, SPLIT_MIN_PANE, splitFits } from "./diffWidth";

export function useDiffView(): [DiffView, (view: DiffView) => void] {
  const saved = useStore((s) => s.settings?.diffView);
  const view: DiffView = DIFF_VIEWS.includes(saved as DiffView) ? (saved as DiffView) : "inline";
  return [view, setDiffView];
}

export function setDiffView(view: DiffView) {
  void rpc.call("settings.set", { diffView: view });
}

const narrow = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function reportNarrow(key: string, on: boolean) {
  if (on === narrow.has(key)) return;
  if (on) narrow.add(key);
  else narrow.delete(key);
  notify();
}

export function useSplitNarrow(prefix: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => [...narrow].some((key) => key.startsWith(prefix)),
  );
}
