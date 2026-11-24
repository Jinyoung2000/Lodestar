
export const WINDOW_QUERY = "window";
export const CHAT_WINDOW_QUERY = "chat";
export const FIRST_WINDOW_ID = "w1";
const ID_PATTERN = /^w[1-9][0-9]{0,5}$/;

export const isWindowId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);

export function windowIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(WINDOW_QUERY);
  return isWindowId(value) ? value : null;
}

export const REMOTE_WINDOW_QUERY = "remote";
const REMOTE_PATTERN = /^[0-9a-f]{16}$/;
export const isRemoteId = (value: unknown): value is string => typeof value === "string" && REMOTE_PATTERN.test(value);

export const windowUrl = (base: string, id: string, initialChat = false, remote?: string) => `${base}/?${WINDOW_QUERY}=${id}${initialChat ? `&${CHAT_WINDOW_QUERY}=1` : ""}${remote ? `&${REMOTE_WINDOW_QUERY}=${remote}` : ""}`;

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export const SCOPE_PREFIX = "agent-nav:w:";
export const scopePrefix = (id: string) => `${SCOPE_PREFIX}${id}:`;

export function scopeOwner(name: string): string | null {
  if (!name.startsWith(SCOPE_PREFIX)) return null;
  const end = name.indexOf(":", SCOPE_PREFIX.length);
  if (end < 0) return null;
  const id = name.slice(SCOPE_PREFIX.length, end);
  return isWindowId(id) ? id : null;
}

function namesOf(base: KeyValueStorage): string[] {
  const names: string[] = [];
  for (let i = 0; i < base.length; i++) {
    const name = base.key(i);
    if (name !== null) names.push(name);
  }
  return names;
}

export function scopedStorage(base: KeyValueStorage, id: string): KeyValueStorage {
  const prefix = scopePrefix(id);
  const own = () => namesOf(base).filter((name) => name.startsWith(prefix));
  return {
    getItem: (key) => base.getItem(prefix + key),
    setItem: (key, value) => base.setItem(prefix + key, value),
    removeItem: (key) => base.removeItem(prefix + key),
    key: (index) => {
      const name = own()[index];
      return name === undefined ? null : name.slice(prefix.length);
    },
    get length() {
      return own().length;
    },
  };
}

export function staleScopeNames(names: readonly string[], liveIds: ReadonlySet<string>): string[] {
  return names.filter((name) => {
    const owner = scopeOwner(name);
    return owner !== null && !liveIds.has(owner);
  });
}

export function sweepStaleScopes(base: KeyValueStorage, liveIds: ReadonlySet<string>): number {
  const stale = staleScopeNames(namesOf(base), liveIds);
  for (const name of stale) base.removeItem(name);
  return stale.length;
}

export const LEGACY_WINDOW_STATE_KEY = "agent-nav:window-state";
export const LEGACY_HOT_EXIT_KEY = "agent-nav:hot-exit";
export const LEGACY_DRAFT_PREFIX = "agent-nav:draft:";

export function migrateLegacyStorage(base: KeyValueStorage, id: string): number {
  if (id !== FIRST_WINDOW_ID) return 0;
  const prefix = scopePrefix(id);
  const names = namesOf(base);
  if (names.some((name) => name.startsWith(prefix))) return 0;
  let moved = 0;
  for (const name of names) {
    if (name !== LEGACY_WINDOW_STATE_KEY && name !== LEGACY_HOT_EXIT_KEY && !name.startsWith(LEGACY_DRAFT_PREFIX)) continue;
    const value = base.getItem(name);
    if (value !== null) {
      base.setItem(prefix + name, value);
      moved++;
    }
    base.removeItem(name);
  }
  return moved;
}

export type Rect = { x: number; y: number; width: number; height: number };
export type WindowRecord = { id: string; bounds: Rect | null; maximized: boolean; fullScreen: boolean; remote?: string };
export type Registry = { version: 1; seq: number; windows: WindowRecord[] };

export const EMPTY_REGISTRY: Registry = { version: 1, seq: 0, windows: [] };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function cleanBounds(value: unknown): Rect | null {
  const b = value as Partial<Rect> | null;
  if (!b || typeof b !== "object" || !num(b.x) || !num(b.y) || !num(b.width) || !num(b.height) || b.width < 1 || b.height < 1) return null;
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}

const idNumber = (id: string) => Number(id.slice(1));

export function parseRegistry(raw: string | null): Registry {
  if (!raw) return EMPTY_REGISTRY;
  try {
    const value = JSON.parse(raw) as { version?: unknown; seq?: unknown; windows?: unknown };
    if (!value || typeof value !== "object" || value.version !== 1 || !Array.isArray(value.windows)) return EMPTY_REGISTRY;
    const seen = new Set<string>();
    const windows: WindowRecord[] = [];
    for (const entry of value.windows as Partial<WindowRecord>[]) {
      if (!entry || !isWindowId(entry.id) || seen.has(entry.id)) continue;
      seen.add(entry.id);
      windows.push({ id: entry.id, bounds: cleanBounds(entry.bounds), maximized: entry.maximized === true, fullScreen: entry.fullScreen === true, ...(isRemoteId(entry.remote) ? { remote: entry.remote } : {}) });
    }
    const seq = Math.max(num(value.seq) ? Math.floor(value.seq) : 0, ...windows.map((w) => idNumber(w.id)), 0);
    return { version: 1, seq, windows };
  } catch {
    return EMPTY_REGISTRY;
  }
}

export const serializeRegistry = (registry: Registry) => JSON.stringify(registry, null, 2);

export function addNewWindow(registry: Registry, bounds: Rect | null = null, remote?: string): { registry: Registry; record: WindowRecord } {
  const seq = registry.seq + 1;
  const record: WindowRecord = { id: `w${seq}`, bounds, maximized: false, fullScreen: false, ...(remote ? { remote } : {}) };
  return { registry: { ...registry, seq, windows: [...registry.windows, record] }, record };
}

export function launchPlan(registry: Registry): { registry: Registry; open: WindowRecord[] } {
  if (registry.windows.length > 0) return { registry, open: registry.windows };
  const fresh = addNewWindow(registry, null);
  return { registry: fresh.registry, open: [fresh.record] };
}

export function newWindowPlan(registry: Registry, aliveIds: ReadonlySet<string>, from: Rect | null): { registry: Registry; record: WindowRecord; reused: boolean } {
  if (aliveIds.size === 0) {
    const kept = registry.windows[registry.windows.length - 1];
    if (kept && !kept.remote) return { registry, record: kept, reused: true };
  }
  const added = addNewWindow(registry, from);
  return { registry: added.registry, record: added.record, reused: false };
}

export type ClosePolicy = "keep" | "remove";
export function closePolicy(input: { quitting: boolean; registryCount: number }): ClosePolicy {
  if (input.quitting) return "keep";
  return input.registryCount <= 1 ? "keep" : "remove";
}

export function applyClose(registry: Registry, id: string, policy: ClosePolicy): Registry {
  if (policy === "keep") return registry;
  return { ...registry, windows: registry.windows.filter((w) => w.id !== id) };
}

export function updateRecord(registry: Registry, id: string, patch: Partial<Omit<WindowRecord, "id">>): Registry {
  if (!registry.windows.some((w) => w.id === id)) return registry;
  return { ...registry, windows: registry.windows.map((w) => (w.id === id ? { ...w, ...patch } : w)) };
}

export function targetWindow(input: { ids: readonly string[]; focusedId: string | null; lastActiveId: string | null }): string | null {
  if (input.focusedId && input.ids.includes(input.focusedId)) return input.focusedId;
  if (input.lastActiveId && input.ids.includes(input.lastActiveId)) return input.lastActiveId;
  return input.ids.length ? input.ids[input.ids.length - 1] : null;
}

export function windowForAgent(input: { windows: readonly { id: string; agentIds: ReadonlySet<string> }[]; agentId: string; focusedId: string | null; lastActiveId: string | null }): string | null {
  const ids = input.windows.map((w) => w.id);
  const showing = input.windows.filter((w) => w.agentIds.has(input.agentId)).map((w) => w.id);
  if (showing.length > 0) return targetWindow({ ids: showing, focusedId: input.focusedId, lastActiveId: input.lastActiveId });
  return targetWindow({ ids, focusedId: input.focusedId, lastActiveId: input.lastActiveId });
}

export const quitWhenAllWindowsClosed = (platform: string) => platform !== "darwin";

const MIN_VISIBLE_W = 120;
const MIN_VISIBLE_H = 60;

export function fitBounds(bounds: Rect | null, areas: readonly Rect[]): Rect | null {
  if (!bounds || areas.length === 0) return null;
  const visible = areas.some((a) => {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const h = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return w >= MIN_VISIBLE_W && h >= MIN_VISIBLE_H;
  });
  if (!visible) return null;
  return bounds;
}

export const CASCADE_STEP = 30;
export function cascade(from: Rect | null, area: Rect): Rect | null {
  if (!from) return null;
  const width = Math.min(from.width, area.width);
  const height = Math.min(from.height, area.height);
  let x = from.x + CASCADE_STEP;
  let y = from.y + CASCADE_STEP;
  if (x + width > area.x + area.width || y + height > area.y + area.height) {
    x = area.x + CASCADE_STEP;
    y = area.y + CASCADE_STEP;
    if (x + width > area.x + area.width) x = area.x;
    if (y + height > area.y + area.height) y = area.y;
  }
  return { x, y, width, height };
}
