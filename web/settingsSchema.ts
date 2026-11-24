
export const GROUP_IDS = ["general", "appearance", "layout", "editor", "diff", "formatting", "browser", "board", "followUps", "notifications", "mentions", "sessions", "providers", "mobile", "desktopLink", "mcp", "status"] as const;
export type GroupId = (typeof GROUP_IDS)[number];

export const GROUP_ICONS: Record<GroupId, string> = {
  general: "gear",
  appearance: "symbol-color",
  layout: "layout",
  editor: "code",
  diff: "diff",
  formatting: "whitespace",
  browser: "globe",
  board: "project",
  followUps: "compass",
  notifications: "bell",
  mentions: "mention",
  sessions: "rocket",
  providers: "server",
  mobile: "device-mobile",
  desktopLink: "remote",
  mcp: "plug",
  status: "pulse",
};

export const NARROW_WIDTH = 600;

export function isNarrow(width: number) {
  return width < NARROW_WIDTH;
}

export type SettingMeta = {
  id: string;
  group: GroupId;
  groupLabel: string;
  title: string;
  description: string;
  keywords: string;
  modified: boolean;
};

export function isModified(current: unknown, defaultValue: unknown) {
  if (current === defaultValue) return false;
  if (typeof current === "number" && typeof defaultValue === "number") return Math.abs(current - defaultValue) > 1e-9;
  return JSON.stringify(current) !== JSON.stringify(defaultValue);
}

export function filterSettings<T extends SettingMeta>(items: readonly T[], query: string, modifiedOnly: boolean): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (modifiedOnly && !item.modified) return false;
    if (!words.length) return true;
    const haystack = `${item.groupLabel} ${item.title} ${item.description} ${item.keywords} ${item.id}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function groupCounts(items: readonly SettingMeta[]) {
  const counts = new Map<GroupId, number>();
  for (const item of items) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
  return counts;
}

export function activeGroup(tops: readonly { id: GroupId; top: number }[], scrollTop: number, slack: number, atBottom = false): GroupId | null {
  if (!tops.length) return null;
  if (atBottom) return tops[tops.length - 1].id;
  let current = tops[0].id;
  for (const entry of tops) if (entry.top <= scrollTop + slack) current = entry.id;
  return current;
}

export function parseSettingNumber(text: string, min: number, max: number, step?: number) {
  if (!text.trim()) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < min - 1e-9 || n > max + 1e-9) return null;
  if (step && Math.abs(n / step - Math.round(n / step)) > 1e-6) return null;
  return n;
}

export type NumberInput = { action: "save"; value: number } | { action: "idle" } | { action: "problem"; reason: "invalid" | "step" };

export function decideNumberInput(text: string, min: number, max: number, step: number | undefined, saved: number): NumberInput {
  const n = parseSettingNumber(text, min, max, step);
  if (n !== null) return Math.abs(n - saved) > 1e-9 ? { action: "save", value: n } : { action: "idle" };
  if (!text.trim()) return { action: "problem", reason: "invalid" };
  const inRange = Number.isFinite(Number(text)) && Number(text) >= min - 1e-9 && Number(text) <= max + 1e-9;
  return { action: "problem", reason: inRange ? "step" : "invalid" };
}

export const NUMBER_SAVE_DELAY_MS = 700;
