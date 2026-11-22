import { useRef, useSyncExternalStore } from "react";
import { getState, subscribe, type State } from "./store";

export function useStoreDerived<I, O>(pick: (s: State) => I, derive: (input: I, prev: { input: I; output: O } | null) => O, equal: (a: O, b: O) => boolean, deps: readonly unknown[] = []): O {
  const cache = useRef<{ input: I; deps: readonly unknown[]; output: O } | null>(null);
  const getSnapshot = () => {
    const input = pick(getState());
    const hit = cache.current;
    if (hit && Object.is(hit.input, input) && sameDeps(hit.deps, deps)) return hit.output;
    const next = derive(input, hit && sameDeps(hit.deps, deps) ? hit : null);
    const output = hit && equal(hit.output, next) ? hit.output : next;
    cache.current = { input, deps, output };
    return output;
  };
  return useSyncExternalStore(subscribe, getSnapshot);
}

const sameDeps = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

export const sameArray = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function sameFields<T extends Record<string, unknown>>(a: T, b: T) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is(a[k], b[k]));
}
