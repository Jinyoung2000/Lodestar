import { useSyncExternalStore } from "react";
import { reviewDateKey, type MorningReview, type ReviewItem, type ReviewState } from "../shared/morningReview";
import type { Board } from "../shared/protocol";
import { notify } from "./notices";
import { boardShown } from "./screenVisibility";
import { rpc } from "./rpc";
import { flash, getState, setState } from "./store";
import { S } from "./strings";

export type MoveState = "done" | "pending" | "blocked";

export function moveStateOf(item: ReviewItem, board: Board | null): MoveState {
  const move = item.move;
  if (!move || !item.cardId) return "blocked";
  const card = board?.cards.find((c) => c.id === item.cardId);
  if (move.applied || card?.columnId === move.toColumnId) return "done";
  if (!card || card.columnId !== move.fromColumnId || !board?.columns.some((c) => c.id === move.toColumnId)) return "blocked";
  return "pending";
}

export const pendingMoveIds = (review: MorningReview, board: Board | null) => review.items.finished.filter((i) => moveStateOf(i, board) === "pending").map((i) => i.cardId!);

export function receiveReview(next: ReviewState) {
  const previous = getState().review;
  setState({ review: next });
  if (!previous || !next.unreadDate || next.unreadDate === previous.unreadDate) return;
  if (getState().centerView === "board" && document.visibilityState === "visible") return;
  if (!boardShown(getState().settings)) return;
  notify({ key: "morning-review", message: S.reviewReadyToast, actions: [{ label: S.reviewOpenBoard, primary: true, run: showMorningReview }] });
}

export function showMorningReview() {
  setState({ centerView: "board" });
  setReviewOpen(true);
}

export function morningReviewCommand() {
  if (!boardShown(getState().settings)) return;
  showMorningReview();
  const review = getState().review;
  if (!review || review.running) return;
  if (!review.reviews.some((r) => r.date === reviewDateKey(new Date()))) void runReviewNow();
}

export async function runReviewNow() {
  const review = getState().review;
  if (review?.running) return;
  try {
    setState({ review: review ? { ...review, running: true, error: null } : review });
    receiveResult(await rpc.call("review.run", {}));
  } catch (error) {
    flash(S.reviewFailed((error as Error).message));
    void refreshReview();
  }
}

export async function refreshReview() {
  try {
    setState({ review: await rpc.call("review.get", {}) });
  } catch {
    setState({ review: null });
  }
}

function receiveResult(next: ReviewState) {
  setState({ review: next });
}

export async function applyReviewMoves(date: string, cardIds: string[] | null) {
  try {
    const result = await rpc.call("review.apply", { date, cardIds });
    setState({ review: result.review });
    if (result.skipped > 0) flash(S.reviewMovesSkipped(result.skipped));
  } catch (error) {
    flash(S.reviewFailed((error as Error).message));
  }
}

export function markReviewSeen(date: string) {
  void rpc.call("review.markSeen", { date }).then((review) => setState({ review })).catch(() => {});
}

const OPEN_KEY = "agent-nav:reviewOpen";
let reviewOpen = readOpen();
const listeners = new Set<() => void>();

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setReviewOpen(open: boolean) {
  if (open === reviewOpen) return;
  reviewOpen = open;
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
  }
  for (const listener of listeners) listener();
}

export function useReviewOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => reviewOpen,
  );
}

export function reviewDayLabel(date: string, now: Date = new Date()): string {
  if (date === reviewDateKey(now)) return S.reviewToday;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date === reviewDateKey(yesterday)) return S.reviewYesterday;
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
