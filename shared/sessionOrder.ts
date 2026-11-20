// 사이드바 세션 목록의 손으로 정한 순서. 웹(web/sessionList.ts 의 묶음 계산, 끌기, 키보드)과 데몬(server/store.ts 의 저장과 입력 검사)이 같은 규칙을 쓰도록 DOM 과 파일을 모르는 함수만 둔다.
//
// 순서는 묶음의 "scope" 마다 id 목록 하나다. scope 는 워크스페이스 묶음이면 그 워크스페이스 id, 워크스페이스를 가로지르는 묶음이면 PINNED_SCOPE, DONE_SCOPE, CHATS_SCOPE,
// 부모 아래 들여쓴 갈래 세션이면 부모마다 kidsScope(부모 id) 다. 고정과 비고정, 완료와 진행 중은 애초에 다른 scope 라 서로의 경계를 넘을 수 없다.
// 사이드바의 폴더 묶음 자체의 순서(Folder Order = Manual)는 FOLDERS_SCOPE 하나이고, 이 scope 의 id 는 세션이 아니라 최상위 워크스페이스 id 다.

export type SessionOrders = Record<string, string[]>;

export const PINNED_SCOPE = "@pinned";
export const DONE_SCOPE = "@done";
export const CHATS_SCOPE = "@chats";
export const FOLDERS_SCOPE = "@folders";
const KIDS_PREFIX = "kids:";

export const kidsScope = (parentId: string) => `${KIDS_PREFIX}${parentId}`;
export const isKidsScope = (scope: string) => scope.startsWith(KIDS_PREFIX);
export const parentOfKidsScope = (scope: string) => scope.slice(KIDS_PREFIX.length);

// 한 scope 에 담을 수 있는 id 수와 id 한 개의 모양. 세션과 워크스페이스 id 는 UUID 라 이보다 넓게 받을 이유가 없다.
export const MAX_ORDER_IDS = 5000;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const RESERVED_SCOPES = [PINNED_SCOPE, DONE_SCOPE, CHATS_SCOPE];

export type ScopeKind = "reserved" | "folders" | "kids" | "workspace";

// 요청 입력의 scope 모양을 검사한다. 그 워크스페이스나 부모 세션이 실제로 있는지는 데몬이 따로 본다.
export function parseOrderScope(value: unknown): { scope: string; kind: ScopeKind } | null {
  if (typeof value !== "string") return null;
  if (value === FOLDERS_SCOPE) return { scope: value, kind: "folders" };
  if (RESERVED_SCOPES.includes(value)) return { scope: value, kind: "reserved" };
  if (isKidsScope(value)) return ID_PATTERN.test(parentOfKidsScope(value)) ? { scope: value, kind: "kids" } : null;
  return ID_PATTERN.test(value) ? { scope: value, kind: "workspace" } : null;
}

// 요청 입력의 id 목록 검사. 배열이 아니거나, 문자열이 아닌 항목이 있거나, 모양이 틀린 id, 상한 초과는 거절한다. 중복은 처음 것만 남긴다.
export function parseOrderIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("ids must be an array of session ids");
  if (value.length > MAX_ORDER_IDS) throw new Error(`ids has more than ${MAX_ORDER_IDS} entries`);
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error("ids must be an array of session ids");
    seen.add(id);
  }
  return [...seen];
}

// 기본 정렬로 놓인 목록에 저장된 순서를 입힌다. 저장 목록이 없거나 비어 있으면 기본 정렬 그대로다.
// 저장 목록에 없는 항목(새 세션)은 기본 정렬 순서 그대로 맨 위에 붙고, 저장 목록에만 있는 id(지워진 세션)는 조용히 빠진다.
export function applySessionOrder<T extends { id: string }>(items: readonly T[], saved: readonly string[] | undefined): T[] {
  if (!saved || saved.length === 0) return [...items];
  const rank = new Map(saved.map((id, index) => [id, index]));
  const fresh = items.filter((item) => !rank.has(item.id));
  const known = items.filter((item) => rank.has(item.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...fresh, ...known];
}

// moving 을 target 의 앞이나 뒤로 옮긴 목록. 둘 중 하나가 목록에 없거나 옮겨도 그대로면 null.
export function moveInOrder(ids: readonly string[], moving: string, target: string, edge: "before" | "after"): string[] | null {
  if (moving === target || !ids.includes(moving) || !ids.includes(target)) return null;
  const rest = ids.filter((id) => id !== moving);
  const at = rest.indexOf(target) + (edge === "after" ? 1 : 0);
  const next = [...rest.slice(0, at), moving, ...rest.slice(at)];
  return next.every((id, index) => id === ids[index]) ? null : next;
}

// moving 을 한 칸 위(-1)나 아래(1)로. limit 는 화면에 보이는 앞쪽 항목 수(Show more 로 접힌 항목 쪽으로는 밀지 않는다).
export function stepInOrder(ids: readonly string[], moving: string, delta: -1 | 1, limit = ids.length): string[] | null {
  const from = ids.indexOf(moving);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= Math.min(limit, ids.length)) return null;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

// 세션과 워크스페이스가 사라진 뒤에 남는 항목을 정리한다. 알 수 없는 id 는 목록에서 빼고, 비게 된 scope 는 지운다.
// FOLDERS_SCOPE 의 id 는 워크스페이스 id 라서 세션이 아니라 known.workspaces 와 맞춘다.
export function pruneSessionOrders(orders: SessionOrders, known: { agents: ReadonlySet<string>; workspaces: ReadonlySet<string> }): SessionOrders {
  const next: SessionOrders = {};
  for (const [scope, ids] of Object.entries(orders)) {
    const parsed = parseOrderScope(scope);
    if (!parsed) continue;
    if (parsed.kind === "workspace" && !known.workspaces.has(scope)) continue;
    if (parsed.kind === "kids" && !known.agents.has(parentOfKidsScope(scope))) continue;
    const live = ids.filter((id) => (parsed.kind === "folders" ? known.workspaces : known.agents).has(id));
    if (live.length) next[scope] = live;
  }
  return next;
}
