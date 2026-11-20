import { useSyncExternalStore } from "react";
import type { Feedback } from "../shared/protocol";
import { canRetryChecks } from "../shared/feedbackRetry";
import { retryTargets } from "./improvementRows";
import { rpc } from "./rpc";
import { flash, getState, openAgent, setState, subscribe } from "./store";
import { S } from "./strings";

// Improvements 화면이 쓰는 피드백 동작. 알림(Feedback.tsx)의 버튼과 같은 RPC 를 같은 문구로 부른다.

// 답 대기 항목의 Reply: 개선 세션을 열고 입력창에 커서를 둔다.
export function replyToFeedback(agentId: string) {
  openAgent(agentId);
  setState({ focusComposer: { paneId: getState().activePaneId, nonce: Date.now() } });
}

export async function revertFeedback(feedback: Feedback) {
  try {
    await rpc.call("feedback.revert", { id: feedback.id });
    flash(S.feedbackReverted);
  } catch (error) {
    flash(S.feedbackRevertFailed((error as Error).message.split("\n")[0]));
  }
}

// FBREDO: 반영 안 됨 항목 정리. 상태는 서버가 저장하고 feedback 이벤트로 목록에 돌아온다.
export async function tidyFeedback(feedback: Feedback, action: "resolve" | "dismiss") {
  try {
    await rpc.call(action === "resolve" ? "feedback.resolve" : "feedback.dismiss", { id: feedback.id });
  } catch (error) {
    flash(S.feedbackTidyFailed((error as Error).message.split("\n")[0]));
  }
}

export async function restartFeedback(feedback: Feedback) {
  try {
    await rpc.call("feedback.restart", { id: feedback.id });
  } catch (error) {
    flash(S.feedbackRestartFailed((error as Error).message));
  }
}

// Retry all not applied: 서버의 검사 재실행은 피드백마다 따로 돌아서 한꺼번에 부르면 tsc 와 build 가 겹친다. 하나가 끝나면 다음을 부른다.
// 반영에 성공하면 서버가 창을 다시 읽게 하므로(reload 이벤트) 남은 목록은 sessionStorage 에 두고, 창이 다시 뜨면 이어서 돈다.
export type RetryAllProgress = { done: number; total: number };
type RetryQueue = { ids: string[]; total: number; skipped: number; savedAt: number };

const QUEUE_KEY = "agent-nav:retry-all";
const QUEUE_TTL_MS = 60 * 60_000; // lint-tokens: allow 남은 목록을 이어서 돌리는 유효 시간(ms)
const START_WAIT_MS = 3000; // lint-tokens: allow 재시도 시작 이벤트를 기다리는 한도(ms)
const FINISH_WAIT_MS = 15 * 60_000; // lint-tokens: allow 한 피드백의 검사를 기다리는 한도(ms)

let progress: RetryAllProgress | null = null;
const listeners = new Set<() => void>();

function setProgress(next: RetryAllProgress | null) {
  progress = next;
  for (const listener of listeners) listener();
}

export function useRetryAll(): RetryAllProgress | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => progress,
  );
}

function loadQueue(): RetryQueue | null {
  try {
    const queue = JSON.parse(sessionStorage.getItem(QUEUE_KEY) ?? "null") as RetryQueue | null;
    return queue && Array.isArray(queue.ids) && Date.now() - queue.savedAt < QUEUE_TTL_MS ? queue : null;
  } catch {
    return null;
  }
}

function saveQueue(queue: RetryQueue | null) {
  try {
    if (queue) sessionStorage.setItem(QUEUE_KEY, JSON.stringify({ ...queue, savedAt: Date.now() }));
    else sessionStorage.removeItem(QUEUE_KEY);
  } catch {
    // 저장하지 못하면 창을 다시 읽을 때 이어 돌지 못할 뿐이다
  }
}

export function retryAllNotApplied() {
  if (progress) return;
  const ids = retryTargets(getState().feedbacks, getState().agents);
  if (ids.length === 0) return;
  void runQueue({ ids, total: ids.length, skipped: 0, savedAt: Date.now() });
}

async function runQueue(queue: RetryQueue) {
  if (progress) return;
  const done = () => queue.total - queue.ids.length;
  setProgress({ done: done(), total: queue.total });
  saveQueue(queue);
  try {
    while (queue.ids.length > 0) {
      const id = queue.ids[0];
      const current = getState().feedbacks[id];
      if (current && isChecking(id)) {
        // 창을 다시 읽기 전에 서버가 이미 돌리기 시작한 것: 끝나기만 기다린다.
        await waitFor(() => !isChecking(id), FINISH_WAIT_MS);
      } else if (current?.status === "failed" && canRetryChecks(current)) {
        try {
          await rpc.call("feedback.retryChecks", { id });
          // 서버 응답이 상태 이벤트보다 먼저 올 수 있어서, 검사가 시작된 것을 본 뒤에 끝나기를 기다린다.
          await waitFor(() => isChecking(id), START_WAIT_MS);
          await waitFor(() => !isChecking(id), FINISH_WAIT_MS);
        } catch {
          queue.skipped++;
        }
      }
      queue.ids.shift();
      saveQueue(queue);
      setProgress({ done: done(), total: queue.total });
    }
  } finally {
    setProgress(null);
    saveQueue(null);
  }
  if (queue.skipped > 0) flash(S.improvementsRetrySkipped(queue.skipped));
}

// 창이 다시 뜬 뒤 서버 목록이 들어오면 남은 목록을 이어서 돈다.
function resumeRetryAll() {
  const queue = loadQueue();
  if (!queue || progress) return;
  const state = getState();
  if (!state.connected || Object.keys(state.feedbacks).length === 0) return;
  void runQueue(queue);
}

if (typeof window !== "undefined" && loadQueue()) {
  const stop = subscribe(() => {
    if (!loadQueue()) stop();
    else if (!progress) resumeRetryAll();
  });
}

function isChecking(id: string): boolean {
  const feedback = getState().feedbacks[id];
  return !!feedback && (feedback.status === "checking" || feedback.status === "fixing" || !!feedback.retrying);
}

// 조건이 참이 되면 true, 한도까지 안 되면 false. 스토어가 바뀔 때마다 다시 본다.
function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  if (condition()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const unsubscribe = subscribe(() => {
      if (condition()) finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
