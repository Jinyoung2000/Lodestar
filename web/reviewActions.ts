import { useSyncExternalStore } from "react";
import { reviewDateKey, type MorningReview, type ReviewItem, type ReviewState } from "../shared/morningReview";
import type { Board } from "../shared/protocol";
import { notify } from "./notices";
import { boardShown } from "./screenVisibility";
import { rpc } from "./rpc";
import { flash, getState, setState } from "./store";
import { S } from "./strings";

// 아침 리뷰 영역의 동작: 지금 만들기, 이동 적용, 새 리뷰 알림, 영역을 접고 펴는 상태. 영역은 web/MorningReview.tsx.

// 이동 제안의 지금 상태: done 은 이미 그 열에 있음(적용했거나 사용자가 옮김), pending 은 누르면 옮길 수 있음, blocked 는 카드가 지워졌거나 다른 열로 가 있어 옮길 수 없음.
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

// 데몬이 보낸 리뷰 상태를 받는다. 처음 읽을 때(창을 다시 읽은 뒤 포함)는 알리지 않고, 새 자동 리뷰가 생겼을 때 한 번만 알린다.
// 그때 Board 를 보고 있으면 영역이 스스로 봤다고 표시하므로 알림은 건너뛴다.
export function receiveReview(next: ReviewState) {
  const previous = getState().review;
  setState({ review: next });
  if (!previous || !next.unreadDate || next.unreadDate === previous.unreadDate) return;
  if (getState().centerView === "board" && document.visibilityState === "visible") return;
  // Board 를 숨겼으면 알림이 가리키는 곳이 없다.
  if (!boardShown(getState().settings)) return;
  notify({ key: "morning-review", message: S.reviewReadyToast, actions: [{ label: S.reviewOpenBoard, primary: true, run: showMorningReview }] });
}

// Board 를 열고 리뷰 영역을 펴 보인다
export function showMorningReview() {
  setState({ centerView: "board" });
  setReviewOpen(true);
}

// 명령 팔레트의 Board: Morning Review. 오늘 리뷰가 없으면 만들고, 있으면 보여 주기만 한다 (다시 만드는 것은 머리의 Review now).
export function morningReviewCommand() {
  // Board 를 숨겼으면 보여 줄 곳이 없으니 리뷰도 만들지 않는다(만들면 모델 비용만 든다).
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
    // 진행과 결과는 review 이벤트로 온다. 실패도 상태의 error 로 오므로 여기서는 요청 자체가 안 간 경우만 알린다.
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

// run 의 응답은 이벤트와 같은 내용이라 알림 없이 상태만 맞춘다
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

// --- 영역을 접고 펴기 (이 창에서 마지막에 고른 대로 기억한다) ---

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
    // 저장이 막힌 환경에서는 창이 열려 있는 동안만 유지
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

// --- 날짜 이름 ---

// 날짜 키(YYYY-MM-DD)를 Today, Yesterday, Mon, Oct 19 로
export function reviewDayLabel(date: string, now: Date = new Date()): string {
  if (date === reviewDateKey(now)) return S.reviewToday;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date === reviewDateKey(yesterday)) return S.reviewYesterday;
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
