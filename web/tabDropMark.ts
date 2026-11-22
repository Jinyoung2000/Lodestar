import { clampDrop } from "./editorTabs";


export type StripTabBox = { key: string; left: number; right: number; sticky: boolean; editor: boolean };

export type DropMark = { beforeKey: string | null; x: number };

export function dropMarkAt(tabs: readonly StripTabBox[], x: number, dragged: { key: string; sticky: boolean }, stripLeft: number): DropMark {
  const raw = tabs.find((t) => x < t.left + (t.right - t.left) / 2)?.key ?? null;
  const editors = tabs.filter((t) => t.editor).map((t) => ({ key: t.key, kind: "file", sticky: t.sticky }));
  const clamped = raw !== null && !editors.some((t) => t.key === raw) ? raw : clampDrop(editors, { key: dragged.key, kind: "file", sticky: dragged.sticky }, raw);
  const target = clamped === null ? undefined : tabs.find((t) => t.key === clamped);
  const last = tabs[tabs.length - 1];
  return { beforeKey: clamped, x: target ? target.left : last ? last.right : stripLeft };
}
