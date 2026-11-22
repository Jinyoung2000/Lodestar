import { MAIN_GROUP } from "./editorGroups";

export type PreviewableTab = { key: string; group?: string; preview?: boolean };

export type OpenMode = "preview" | "pinned";
export type OpenPlan<T> = {
  tabs: T[];
  replaced: string | null;
  added: boolean;
};

const groupOf = (tab: PreviewableTab) => tab.group ?? MAIN_GROUP;

export function planOpen<T extends PreviewableTab>(tabs: T[], group: string, next: T, mode: OpenMode): OpenPlan<T> {
  const existing = tabs.find((t) => t.key === next.key);
  if (existing) return { tabs: mode === "pinned" ? pinTab(tabs, next.key) : tabs, replaced: null, added: false };
  const { group: _ignored, preview: _stale, ...rest } = next;
  const placed = { ...rest, ...(group === MAIN_GROUP ? {} : { group }), ...(mode === "preview" ? { preview: true } : {}) } as unknown as T;
  const slot = mode === "preview" ? tabs.findIndex((t) => t.preview === true && groupOf(t) === group) : -1;
  if (slot === -1) return { tabs: [...tabs, placed], replaced: null, added: true };
  const out = [...tabs];
  const replaced = out[slot].key;
  out[slot] = placed;
  return { tabs: out, replaced, added: true };
}

export function pinTab<T extends PreviewableTab>(tabs: T[], key: string): T[] {
  if (!tabs.some((t) => t.key === key && t.preview)) return tabs;
  return tabs.map((t) => {
    if (t.key !== key) return t;
    const { preview: _gone, ...rest } = t;
    return rest as T;
  });
}

export const isPreview = (tab: PreviewableTab | undefined) => tab?.preview === true;
