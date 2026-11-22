import type { InboxItem } from "../shared/protocol";

export type InboxShow = "unread" | "all" | "archived";

type Row = Pick<InboxItem, "id" | "time" | "read" | "archived"> & Partial<Pick<InboxItem, "kind">>;

export type InboxKindFilter = "all" | "mention" | "thread";

export const matchesShow = (item: Pick<InboxItem, "read" | "archived">, show: InboxShow): boolean => (show === "archived" ? item.archived : !item.archived && (show === "all" || !item.read));

export const matchesKind = (item: Partial<Pick<InboxItem, "kind">>, kind: InboxKindFilter): boolean => kind === "all" || item.kind === kind;

export function inboxRows<T extends Row>(items: readonly T[], show: InboxShow, selectedId: string | null, kind: InboxKindFilter = "all"): T[] {
  return items.filter((i) => (matchesShow(i, show) && matchesKind(i, kind)) || i.id === selectedId).sort((a, b) => b.time.localeCompare(a.time));
}

export function inboxKindCounts(items: readonly Pick<InboxItem, "kind" | "read" | "archived">[], show: InboxShow): Record<InboxKindFilter, number> {
  const shown = items.filter((i) => matchesShow(i, show));
  return { all: shown.length, mention: shown.filter((i) => i.kind === "mention").length, thread: shown.filter((i) => i.kind === "thread").length };
}

export function neighborRowId(rows: readonly { id: string }[], selectedId: string | null, step: 1 | -1): string | null {
  if (rows.length === 0) return null;
  const at = rows.findIndex((r) => r.id === selectedId);
  if (at === -1) return rows[step === 1 ? 0 : rows.length - 1].id;
  return rows[at + step]?.id ?? null;
}
