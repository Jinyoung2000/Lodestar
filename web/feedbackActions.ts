import { useSyncExternalStore } from "react";
import type { Feedback } from "../shared/protocol";
import { canRetryChecks } from "../shared/feedbackRetry";
import { retryTargets } from "./improvementRows";
import { rpc } from "./rpc";
import { flash, getState, openAgent, setState, subscribe } from "./store";
import { S } from "./strings";

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
        await waitFor(() => !isChecking(id), FINISH_WAIT_MS);
      } else if (current?.status === "failed" && canRetryChecks(current)) {
        try {
          await rpc.call("feedback.retryChecks", { id });
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
