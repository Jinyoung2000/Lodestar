// Mentions 화면 목록 거르기. 시험: test/splitpanels.test.ts
import type { InboxItem } from "../shared/protocol";

export type InboxShow = "unread" | "all" | "archived";

type Row = Pick<InboxItem, "id" | "time" | "read" | "archived"> & Partial<Pick<InboxItem, "kind">>;

// 종류 거르기. all 은 멘션과 스레드 답글 모두.
export type InboxKindFilter = "all" | "mention" | "thread";

export const matchesShow = (item: Pick<InboxItem, "read" | "archived">, show: InboxShow): boolean => (show === "archived" ? item.archived : !item.archived && (show === "all" || !item.read));

export const matchesKind = (item: Partial<Pick<InboxItem, "kind">>, kind: InboxKindFilter): boolean => kind === "all" || item.kind === kind;

// 필터에 맞는 항목을 최신순으로. 지금 상세 칸에 열린 항목은 필터와 맞지 않게 되어도(열면서 읽음 처리돼 Unread 에서 빠지는 경우) 고른 동안 목록에 남긴다.
// 다른 항목을 고르거나 상세를 닫으면 selectedId 가 바뀌므로 그때 빠진다.
export function inboxRows<T extends Row>(items: readonly T[], show: InboxShow, selectedId: string | null, kind: InboxKindFilter = "all"): T[] {
  return items.filter((i) => (matchesShow(i, show) && matchesKind(i, kind)) || i.id === selectedId).sort((a, b) => b.time.localeCompare(a.time));
}

// 종류 탭에 붙는 개수. 지금 고른 보기(Unread, All, Archived)에 맞는 항목만 센다.
export function inboxKindCounts(items: readonly Pick<InboxItem, "kind" | "read" | "archived">[], show: InboxShow): Record<InboxKindFilter, number> {
  const shown = items.filter((i) => matchesShow(i, show));
  return { all: shown.length, mention: shown.filter((i) => i.kind === "mention").length, thread: shown.filter((i) => i.kind === "thread").length };
}

// ↑ ↓ 로 옮길 다음 항목의 id. 고른 항목이 없으면 위는 마지막, 아래는 첫 항목. 끝에서는 제자리(null).
export function neighborRowId(rows: readonly { id: string }[], selectedId: string | null, step: 1 | -1): string | null {
  if (rows.length === 0) return null;
  const at = rows.findIndex((r) => r.id === selectedId);
  if (at === -1) return rows[step === 1 ? 0 : rows.length - 1].id;
  return rows[at + step]?.id ?? null;
}
