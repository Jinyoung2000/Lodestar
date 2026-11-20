// 실패한 개선(Not applied)의 알림은 서버 기록의 seen 이 false 인 동안 앱을 켤 때마다 다시 떴다(닫기 전까지 남는 오류 알림이라서).
// 한 번 보여 준 실패는 이 기기의 localStorage 에 기억해서 다음 실행에서는 알림을 띄우지 않는다. 서버의 seen 은 건드리지 않으므로 제목줄 피드백 버튼의 점과 Improvements 목록은 그대로다.
// 키에 updatedAt 이 들어 있어서 Retry 뒤 다시 실패하면 새 실패로 알린다.
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
    // 저장이 막힌 환경(비공개 창 등)에서는 이번 실행 안에서만 기억한다
  }
}

// 알림을 띄울 실패인가. 이전 실행에서 이미 보여 준 실패만 가리고, 이번 실행에서 보여 주기 시작한 것은 닫을 때까지 계속 보인다.
export function showFailureNotice(key: string, previousRun: ReadonlySet<string>, thisRun: ReadonlySet<string>) {
  return !previousRun.has(key) || thisRun.has(key);
}

// 화면이 쓰는 쪽: 이 실행이 시작될 때 읽어 둔 기억(previousRun)과 이번 실행에서 보여 주기 시작한 실패(thisRun).
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

// 지금 알림으로 보이는 실패들을 기억에 올린다. 이미 올린 것은 건너뛴다.
export function rememberFailureNotices(feedbacks: readonly { id: string; updatedAt: string }[]) {
  start();
  const added = feedbacks.map(failureNoticeKey).filter((key) => !thisRun.has(key));
  if (added.length === 0) return;
  for (const key of added) thisRun.add(key);
  remembered = [...remembered.filter((key) => !added.includes(key)), ...added];
  saveFailureMemory(browserStorage(), remembered);
}
