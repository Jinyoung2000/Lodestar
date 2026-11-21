import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ScmStatus } from "../shared/scm";
import { rpc } from "./rpc";
import { useStore } from "./store";
import { onWorkspaceChanged } from "./workspaceEvents";

// SCM: Source Control 보기의 작은 상태. 탭을 바꾸면 보기가 사라졌다 다시 만들어지므로 입력 중인 메시지와 접힘, 트리 보기는 여기에 둔다.

export type ScmSection = "merge" | "staged" | "changes" | "worktrees" | "graph";

type View = { tree: boolean; collapsed: Partial<Record<ScmSection, boolean>>; drafts: Record<string, string> };

const KEY = "agent-nav:scm-view";

const DEFAULT_COLLAPSED: View["collapsed"] = { worktrees: true };

function load(): Pick<View, "tree" | "collapsed"> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<View> & { treeChosen?: boolean };
    return { tree: raw.treeChosen === true, collapsed: { ...DEFAULT_COLLAPSED, ...(raw.collapsed && typeof raw.collapsed === "object" ? raw.collapsed : {}) } };
  } catch {
    return { tree: false, collapsed: DEFAULT_COLLAPSED };
  }
}

let view: View = { ...load(), drafts: {} };
const listeners = new Set<() => void>();

function set(patch: Partial<View>) {
  view = { ...view, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify({ treeChosen: view.tree, collapsed: view.collapsed }));
  } catch {
    // 저장이 막힌 환경에서는 이번 실행 동안만 유지한다
  }
  listeners.forEach((l) => l());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useScmView<T>(select: (v: View) => T): T {
  return useSyncExternalStore(subscribe, () => select(view));
}

export const setScmTree = (tree: boolean) => set({ tree });
export const toggleScmSection = (section: ScmSection) => set({ collapsed: { ...view.collapsed, [section]: !view.collapsed[section] } });
export const setScmDraft = (key: string, text: string) => set({ drafts: { ...view.drafts, [key]: text } });
export const scmDraftKey = (agentId: string | null, workspaceId: string | null) => agentId ?? workspaceId ?? "";

// --- 상태 읽기 ---

const FOCUS_DEBOUNCE_MS = 400;

// 저장소 상태. 읽는 때: 보기가 열릴 때, 세션의 변경 목록이 다시 읽혔을 때(편집 도구, 저장, 체크포인트가 모두 거친다), 세션 상태가 바뀔 때(턴 시작과 끝), 창이 다시 포커스를 받을 때.
export function useScmStatus(agentId: string | null, workspaceId: string | null) {
  const [status, setStatus] = useState<ScmStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      const next = await rpc.call("scm.status", { agentId: agentId ?? undefined, workspaceId: workspaceId ?? undefined });
      if (mine !== sequence.current) return;
      setStatus(next);
      setError(null);
    } catch (e) {
      if (mine === sequence.current) setError((e as Error).message);
    }
  }, [agentId, workspaceId]);
  const gitChanges = useStore((s) => (agentId ? s.gitChanges[agentId] : undefined));
  const agentStatus = useStore((s) => (agentId ? s.agents.find((a) => a.id === agentId)?.status : undefined));
  useEffect(() => {
    void reload();
  }, [reload, gitChanges, agentStatus]);
  // FIX4A: 포커스 없이도 바깥(다른 편집기, 터미널)의 파일 변화를 데몬의 파일 감시가 알려 준다
  const watched = useStore((s) => workspaceId ?? (agentId ? (s.agents.find((a) => a.id === agentId)?.workspaceId ?? null) : null));
  useEffect(() => onWorkspaceChanged(watched, () => void reload()), [watched, reload]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), FOCUS_DEBOUNCE_MS);
    };
    const visible = () => document.visibilityState === "visible" && soon();
    window.addEventListener("focus", soon);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", soon);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [reload]);
  return { status, error, reload };
}
