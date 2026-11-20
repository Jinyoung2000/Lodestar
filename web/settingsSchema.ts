// Settings 화면의 순수 로직: 묶음 목록, 기본값과 다른지 판정, 검색 거르기, 스크롤 위치로 현재 묶음 찾기, 좁은 폭 판정.
// 화면(SettingsView.tsx)과 항목 정의(settingsItems.ts)는 여기를 부른다. React 와 문구에 의존하지 않아 단독으로 시험한다(test/settingsschema.test.ts).

export const GROUP_IDS = ["appearance", "layout", "editor", "diff", "formatting", "browser", "board", "notifications", "mentions", "sessions", "mobile", "linear", "import", "mcp", "status"] as const;
export type GroupId = (typeof GROUP_IDS)[number];

// 목차 아이콘(codicon 이름)
export const GROUP_ICONS: Record<GroupId, string> = {
  appearance: "symbol-color",
  layout: "layout",
  editor: "code",
  diff: "diff",
  formatting: "whitespace",
  browser: "globe",
  board: "project",
  notifications: "bell",
  mentions: "mention",
  sessions: "rocket",
  mobile: "device-mobile",
  linear: "issues",
  import: "cloud-download",
  mcp: "plug",
  status: "pulse",
};

export const NARROW_WIDTH = 600;

export function isNarrow(width: number) {
  return width < NARROW_WIDTH;
}

// 검색과 목록에 필요한 행의 요약. modified 는 호출하는 쪽이 현재 설정으로 계산해 넣는다.
export type SettingMeta = {
  id: string;
  group: GroupId;
  groupLabel: string;
  title: string;
  description: string;
  // 이름과 설명에 없는 검색어(옛 이름, 설정 키)
  keywords: string;
  modified: boolean;
};

// 현재 값이 기본값과 다른가. 숫자는 부동소수 오차를 무시하고, 객체와 null 은 값으로 비교한다.
export function isModified(current: unknown, defaultValue: unknown) {
  if (current === defaultValue) return false;
  if (typeof current === "number" && typeof defaultValue === "number") return Math.abs(current - defaultValue) > 1e-9;
  return JSON.stringify(current) !== JSON.stringify(defaultValue);
}

// 공백으로 나눈 낱말이 모두 묶음 이름, 이름, 설명, 키워드, id 중 어딘가에 들어 있는 행만. 대소문자는 무시한다.
export function filterSettings<T extends SettingMeta>(items: readonly T[], query: string, modifiedOnly: boolean): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (modifiedOnly && !item.modified) return false;
    if (!words.length) return true;
    const haystack = `${item.groupLabel} ${item.title} ${item.description} ${item.keywords} ${item.id}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

// 묶음별 행 수(남은 행이 있는 묶음만 키로 들어간다)
export function groupCounts(items: readonly SettingMeta[]) {
  const counts = new Map<GroupId, number>();
  for (const item of items) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
  return counts;
}

// 스크롤 위치에서 지금 읽고 있는 묶음: 머리가 scrollTop + slack 이하인 마지막 묶음. 맨 아래까지 내렸으면 마지막 묶음.
export function activeGroup(tops: readonly { id: GroupId; top: number }[], scrollTop: number, slack: number, atBottom = false): GroupId | null {
  if (!tops.length) return null;
  if (atBottom) return tops[tops.length - 1].id;
  let current = tops[0].id;
  for (const entry of tops) if (entry.top <= scrollTop + slack) current = entry.id;
  return current;
}

// 숫자 입력 검증: 빈 칸, 숫자가 아님, 범위 밖, 단위(step) 배수가 아님이면 null. 통과하면 숫자.
export function parseSettingNumber(text: string, min: number, max: number, step?: number) {
  if (!text.trim()) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < min - 1e-9 || n > max + 1e-9) return null;
  if (step && Math.abs(n / step - Math.round(n / step)) > 1e-6) return null;
  return n;
}

// C: 숫자 입력 한 번의 결과. 입력하는 동안은 키마다 저장하지 않으므로(0.1 을 치는 중간의 "0" 이 저장되던 문제) 판정과 저장 시점을 나눈다.
// save 는 유효하고 저장된 값과 다른 값(지연 뒤나 Enter, blur 에 저장), idle 은 할 일 없음(비었거나 저장된 값과 같음), problem 은 이유와 함께 안내를 띄운다.
export type NumberInput = { action: "save"; value: number } | { action: "idle" } | { action: "problem"; reason: "invalid" | "step" };

export function decideNumberInput(text: string, min: number, max: number, step: number | undefined, saved: number): NumberInput {
  const n = parseSettingNumber(text, min, max, step);
  if (n !== null) return Math.abs(n - saved) > 1e-9 ? { action: "save", value: n } : { action: "idle" };
  if (!text.trim()) return { action: "problem", reason: "invalid" };
  const inRange = Number.isFinite(Number(text)) && Number(text) >= min - 1e-9 && Number(text) <= max + 1e-9;
  return { action: "problem", reason: inRange ? "step" : "invalid" };
}

// 입력을 멈춘 뒤 이 시간이 지나면 유효한 값을 저장한다
export const NUMBER_SAVE_DELAY_MS = 700;
