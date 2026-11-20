import { useRef, useSyncExternalStore } from "react";
import { getState, subscribe, type State } from "./store";

// 스토어의 큰 값(예: 세션 타임라인 배열)에서 작은 값을 뽑아 쓰는 컴포넌트용.
// useStore((s) => s.timelines[id]) 로 배열을 통째로 구독하면 항목 하나가 바뀔 때마다 이 컴포넌트가 다시 그려진다.
// 여기서는 뽑은 값(derive 결과)이 equal 로 같으면 이전 참조를 돌려줘서, 결과가 그대로면 다시 그리지 않는다. pick 결과가 같은 참조면 derive 도 건너뛴다.
// derive 가 쓰는 props 가 있으면 deps 에 넣는다(바뀌면 다시 계산).
// derive 는 두 번째 인자로 지난 입력과 결과를 받는다(deps 가 같을 때만). 긴 타임라인에서 바뀐 뒤쪽만 다시 보는 계산이 쓴다(PERF2).
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
