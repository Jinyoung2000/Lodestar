export type StorageLike = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "agent-nav.seenFailureNotices";
const MAX_KEYS = 200;

export const failureNoticeKey = (feedback: { id: string; updatedAt: string }) => `${feedback.id}:${feedback.updatedAt}`;

export function loadFailureMemory(storage: StorageLike | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

export function saveFailureMemory(storage: StorageLike | undefined, keys: readonly string[]) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(keys.slice(-MAX_KEYS)));
  } catch {
  }
}

export function showFailureNotice(key: string, previousRun: ReadonlySet<string>, thisRun: ReadonlySet<string>) {
  return !previousRun.has(key) || thisRun.has(key);
}

let previousRun: Set<string> | null = null;
let remembered: string[] = [];
const thisRun = new Set<string>();

function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function start() {
  if (previousRun) return previousRun;
  remembered = loadFailureMemory(browserStorage());
  previousRun = new Set(remembered);
  return previousRun;
}

export function failureNoticeHidden(feedback: { id: string; updatedAt: string }) {
  return !showFailureNotice(failureNoticeKey(feedback), start(), thisRun);
}

export function rememberFailureNotices(feedbacks: readonly { id: string; updatedAt: string }[]) {
  start();
  const added = feedbacks.map(failureNoticeKey).filter((key) => !thisRun.has(key));
  if (added.length === 0) return;
  for (const key of added) thisRun.add(key);
  remembered = [...remembered.filter((key) => !added.includes(key)), ...added];
  saveFailureMemory(browserStorage(), remembered);
}
