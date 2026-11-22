
export type SessionOrders = Record<string, string[]>;

export const PINNED_SCOPE = "@pinned";
export const DONE_SCOPE = "@done";
export const CHATS_SCOPE = "@chats";
export const FOLDERS_SCOPE = "@folders";
const KIDS_PREFIX = "kids:";

export const kidsScope = (parentId: string) => `${KIDS_PREFIX}${parentId}`;
export const isKidsScope = (scope: string) => scope.startsWith(KIDS_PREFIX);
export const parentOfKidsScope = (scope: string) => scope.slice(KIDS_PREFIX.length);

export const MAX_ORDER_IDS = 5000;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const RESERVED_SCOPES = [PINNED_SCOPE, DONE_SCOPE, CHATS_SCOPE];

export type ScopeKind = "reserved" | "folders" | "kids" | "workspace";

export function parseOrderScope(value: unknown): { scope: string; kind: ScopeKind } | null {
  if (typeof value !== "string") return null;
  if (value === FOLDERS_SCOPE) return { scope: value, kind: "folders" };
  if (RESERVED_SCOPES.includes(value)) return { scope: value, kind: "reserved" };
  if (isKidsScope(value)) return ID_PATTERN.test(parentOfKidsScope(value)) ? { scope: value, kind: "kids" } : null;
  return ID_PATTERN.test(value) ? { scope: value, kind: "workspace" } : null;
}

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

export function applySessionOrder<T extends { id: string }>(items: readonly T[], saved: readonly string[] | undefined): T[] {
  if (!saved || saved.length === 0) return [...items];
  const rank = new Map(saved.map((id, index) => [id, index]));
  const fresh = items.filter((item) => !rank.has(item.id));
  const known = items.filter((item) => rank.has(item.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...fresh, ...known];
}

export function moveInOrder(ids: readonly string[], moving: string, target: string, edge: "before" | "after"): string[] | null {
  if (moving === target || !ids.includes(moving) || !ids.includes(target)) return null;
  const rest = ids.filter((id) => id !== moving);
  const at = rest.indexOf(target) + (edge === "after" ? 1 : 0);
  const next = [...rest.slice(0, at), moving, ...rest.slice(at)];
  return next.every((id, index) => id === ids[index]) ? null : next;
}

export function stepInOrder(ids: readonly string[], moving: string, delta: -1 | 1, limit = ids.length): string[] | null {
  const from = ids.indexOf(moving);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= Math.min(limit, ids.length)) return null;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

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
