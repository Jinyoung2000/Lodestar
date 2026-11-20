// 여러 창의 순수 로직. Electron 과 DOM 을 import 하지 않아 메인, 페이지, test/windows.test.ts 가 같이 쓴다.
// 창마다 id(w1, w2, ...)가 있고, 메인은 창을 ?window=<id> 주소로 연다. 페이지는 그 id 로 localStorage 를 나눠 쓴다.

export const WINDOW_QUERY = "window";
export const FIRST_WINDOW_ID = "w1";
const ID_PATTERN = /^w[1-9][0-9]{0,5}$/;

export const isWindowId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);

// 주소의 ?window=<id>. 모양이 맞지 않거나 없으면 null(브라우저로 붙은 화면은 창 id 가 없다).
export function windowIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(WINDOW_QUERY);
  return isWindowId(value) ? value : null;
}

export const windowUrl = (base: string, id: string) => `${base}/?${WINDOW_QUERY}=${id}`;

// --- 저장소 범위: 창마다 localStorage 이름 앞에 agent-nav:w:<id>: 를 붙여 따로 쓴다 ---

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export const SCOPE_PREFIX = "agent-nav:w:";
export const scopePrefix = (id: string) => `${SCOPE_PREFIX}${id}:`;

// 이름이 어느 창의 범위인지. 범위 밖 이름이면 null.
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

// 한 창의 범위만 보이는 저장소. key(i) 와 length 도 범위 안의 이름만 세므로 "agent-nav:draft:" 같은 접두 순회가 다른 창의 것을 보거나 지우지 못한다.
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

// 살아 있는 창(registry 에 있는 창) 목록에 없는 창의 범위 이름들. 닫힌 창의 저장본이 남은 것이다.
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

// 창이 하나이던 때의 저장본. 첫 창이 자기 범위가 비어 있을 때 한 번 자기 범위로 옮겨 가져가고 옛 이름은 지운다.
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

// --- 창 목록(registry): 앱을 껐다 켜도 같은 창들이 돌아오도록 메인이 파일에 남긴다 ---

export type Rect = { x: number; y: number; width: number; height: number };
export type WindowRecord = { id: string; bounds: Rect | null; maximized: boolean; fullScreen: boolean };
export type Registry = { version: 1; seq: number; windows: WindowRecord[] };

export const EMPTY_REGISTRY: Registry = { version: 1, seq: 0, windows: [] };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function cleanBounds(value: unknown): Rect | null {
  const b = value as Partial<Rect> | null;
  if (!b || typeof b !== "object" || !num(b.x) || !num(b.y) || !num(b.width) || !num(b.height) || b.width < 1 || b.height < 1) return null;
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}

const idNumber = (id: string) => Number(id.slice(1));

// 깨진 파일, 모르는 버전은 빈 목록. 같은 id 는 하나만 남기고, seq 는 지금까지 쓴 가장 큰 id 번호 이상으로 올린다(id 를 다시 쓰지 않는다).
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
      windows.push({ id: entry.id, bounds: cleanBounds(entry.bounds), maximized: entry.maximized === true, fullScreen: entry.fullScreen === true });
    }
    const seq = Math.max(num(value.seq) ? Math.floor(value.seq) : 0, ...windows.map((w) => idNumber(w.id)), 0);
    return { version: 1, seq, windows };
  } catch {
    return EMPTY_REGISTRY;
  }
}

export const serializeRegistry = (registry: Registry) => JSON.stringify(registry, null, 2);

// 새 창 하나를 만들어 목록 끝에 넣는다. id 는 seq 다음 번호.
export function addNewWindow(registry: Registry, bounds: Rect | null = null): { registry: Registry; record: WindowRecord } {
  const seq = registry.seq + 1;
  const record: WindowRecord = { id: `w${seq}`, bounds, maximized: false, fullScreen: false };
  return { registry: { ...registry, seq, windows: [...registry.windows, record] }, record };
}

// 앱을 켤 때 열 창들. 저장본이 비었으면 새 창 하나(첫 실행, 또는 옛 단일 창 저장본을 가져갈 w1).
export function launchPlan(registry: Registry): { registry: Registry; open: WindowRecord[] } {
  if (registry.windows.length > 0) return { registry, open: registry.windows };
  const fresh = addNewWindow(registry, null);
  return { registry: fresh.registry, open: [fresh.record] };
}

// 새 창 요청(⇧⌘N, Dock 메뉴)이나 activate 에서 열 창. 열린 창이 하나도 없으면 목록에 남은 마지막 창을 되살리고(그 창의 저장본이 다음 실행 기본값이다), 열린 창이 있으면 새 id 의 빈 창이다.
export function newWindowPlan(registry: Registry, aliveIds: ReadonlySet<string>, from: Rect | null): { registry: Registry; record: WindowRecord; reused: boolean } {
  if (aliveIds.size === 0) {
    const kept = registry.windows[registry.windows.length - 1];
    if (kept) return { registry, record: kept, reused: true };
  }
  const added = addNewWindow(registry, from);
  return { registry: added.registry, record: added.record, reused: false };
}

// 창이 닫혔을 때 목록에서 어떻게 할지. 앱이 끝나는 중이면 목록을 그대로 두고(다음 실행이 그 창들을 되살린다), 마지막 창이면 남겨서 다음 실행과 다음 새 창의 기본값으로 쓴다.
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

// --- 명령과 알림이 갈 창 고르기 ---

// 메뉴 명령, 전역 단축키, E2E 기본 대상. OS 가 포커스를 준 창, 없으면 마지막으로 활성이던 창, 없으면 가장 나중에 만든 창이다.
// 시험 인스턴스(AGENT_NAV_INACTIVE)는 창이 포커스를 받지 않으므로 둘째가 대신한다.
export function targetWindow(input: { ids: readonly string[]; focusedId: string | null; lastActiveId: string | null }): string | null {
  if (input.focusedId && input.ids.includes(input.focusedId)) return input.focusedId;
  if (input.lastActiveId && input.ids.includes(input.lastActiveId)) return input.lastActiveId;
  return input.ids.length ? input.ids[input.ids.length - 1] : null;
}

// 알림을 눌렀을 때 그 세션을 열 창. 그 세션이 칸에 열린 창 중에서 targetWindow 순서로 고르고, 어디에도 안 열려 있으면 targetWindow 다.
export function windowForAgent(input: { windows: readonly { id: string; agentIds: ReadonlySet<string> }[]; agentId: string; focusedId: string | null; lastActiveId: string | null }): string | null {
  const ids = input.windows.map((w) => w.id);
  const showing = input.windows.filter((w) => w.agentIds.has(input.agentId)).map((w) => w.id);
  if (showing.length > 0) return targetWindow({ ids: showing, focusedId: input.focusedId, lastActiveId: input.lastActiveId });
  return targetWindow({ ids, focusedId: input.focusedId, lastActiveId: input.lastActiveId });
}

// 마지막 창이 닫혔을 때 앱을 끝낼지. macOS 는 창이 없어도 Dock 에 남는다(세션과 백그라운드 에이전트가 이어진다).
export const quitWhenAllWindowsClosed = (platform: string) => platform !== "darwin";

// --- 창 자리 ---

const MIN_VISIBLE_W = 120;
const MIN_VISIBLE_H = 60;

// 저장해 둔 자리가 지금 연결된 화면 어딘가에 충분히 보이면 그대로, 아니면 null(Electron 이 가운데에 둔다). 화면보다 큰 크기는 가장 큰 화면에 맞춘다.
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

// 새 창은 기준 창에서 오른쪽 아래로 CASCADE_STEP 만큼 밀어 연다. 화면 밖으로 나가면 화면 왼쪽 위에서 다시 시작한다.
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
