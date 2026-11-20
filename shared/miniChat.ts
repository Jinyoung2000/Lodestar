// 미니 채팅 패널의 순수 규칙: 런처(입력 막대)와 대화 전환, blur 로 숨길지, 저장한 자리의 보정, 알림이 향할 곳, 저장 파일.
// electron 을 import 하지 않아 test/minichat.test.ts 가 그대로 돌린다. 실제 창은 electron/quickEntry.ts, 페이지는 web/QuickEntry.tsx(?view=quick)와 web/MiniChat.tsx(?embed=session&mini=1)다.

export type Rect = { x: number; y: number; width: number; height: number };

// launcher: 입력 막대. chat: 세션 하나를 보여 주는 대화 패널.
export type MiniMode = "launcher" | "chat";

// agentId 가 있으면 다음에 열 때 그 대화가 나온다. 없으면 입력 막대다.
export type MiniState = { mode: MiniMode; agentId: string | null };

export const MINI_INITIAL: MiniState = { mode: "launcher", agentId: null };

export const modeFor = (agentId: string | null): MiniMode => (agentId ? "chat" : "launcher");

export function stateFor(agentId: string | null): MiniState {
  return { mode: modeFor(agentId), agentId };
}

// --- 주소 ---

export function miniUrl(base: string, agentId: string | null, theme?: "dark" | "light"): string {
  const suffix = theme ? `&theme=${theme}` : "";
  if (!agentId) return `${base}/?view=quick${suffix}`;
  return `${base}/?embed=session&agent=${encodeURIComponent(agentId)}&mini=1${suffix}`;
}

// --- 보낸 뒤 ---

export type SendOutcome = { state: MiniState; hide: boolean };

// 런처에서 보냈다. Enter 는 패널이 대화로 커지고(hide false), ⌘Enter 는 대화를 묶어 두고 패널은 숨긴다(hide true).
export function afterSend(agentId: string, stay: boolean): SendOutcome {
  return { state: stateFor(agentId), hide: stay };
}

// 새 미니 대화: 묶인 세션을 풀고 입력 막대로 돌아간다.
export const afterNew = (): MiniState => MINI_INITIAL;

// --- blur ---

export type BlurInput = {
  mode: MiniMode;
  // 고정(핀)이면 대화 중에는 바깥을 눌러도 숨기지 않는다. Settings 의 Hide on outside click 이 꺼져 있으면 기본으로 고정이다.
  pinned: boolean;
  // 시험 인스턴스나 창구 실행: 창이 포커스를 갖지 못하니 blur 로 숨기지 않는다.
  inactive: boolean;
  sinceShownMs: number;
  guardMs: number;
};

// 막 뜬 직후의 포커스 흔들림은 무시한다. 입력 막대는 늘 blur 로 닫히고(지금까지의 동작), 대화는 핀이 풀렸을 때만 닫힌다.
export function blurAction(input: BlurInput): "hide" | "keep" {
  if (input.inactive) return "keep";
  if (input.sinceShownMs <= input.guardMs) return "keep";
  if (input.mode === "chat" && input.pinned) return "keep";
  return "hide";
}

// 핀: Settings 의 miniChatHideOnBlur 가 꺼져 있으면 고정이 기본이다.
export const pinnedFromSetting = (hideOnBlur: boolean | undefined): boolean => hideOnBlur !== true;

// --- 알림 ---

export type NotifyInput = { agentId: string; miniAgentId: string | null; miniVisible: boolean };

// suppress: 미니 대화가 화면에 보이는 중이라 알리지 않는다. mini: 숨겨 둔 미니 대화의 세션이라 OS 알림을 띄우고, 누르면 미니 패널을 연다. default: 기존 경로.
export function notificationTarget(input: NotifyInput): "suppress" | "mini" | "default" {
  if (!input.miniAgentId || input.agentId !== input.miniAgentId) return "default";
  return input.miniVisible ? "suppress" : "mini";
}

// --- 저장한 자리 ---

export type MiniSaved = { bounds: Rect | null; agentId: string | null };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseMiniSaved(raw: string | null): MiniSaved {
  try {
    const value = JSON.parse(raw ?? "null") as { bounds?: Partial<Rect> | null; agentId?: unknown } | null;
    const b = value?.bounds;
    const bounds = b && num(b.x) && num(b.y) && num(b.width) && num(b.height) && b.width >= 1 && b.height >= 1 ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null;
    return { bounds, agentId: typeof value?.agentId === "string" && value.agentId !== "" ? value.agentId : null };
  } catch {
    return { bounds: null, agentId: null };
  }
}

export const serializeMiniSaved = (saved: MiniSaved): string => JSON.stringify({ bounds: saved.bounds, agentId: saved.agentId });

// --- 자리와 크기 ---

export type Size = { width: number; height: number };

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// 화면이 바뀌어도(모니터를 뺐거나 해상도가 달라짐) 패널이 보이는 영역 안에 있게 한다. 크기는 [min, 작업 영역] 안으로, 자리는 작업 영역 안으로 당긴다.
// 가장 많이 겹치는 화면을 고르고, 어느 화면과도 안 겹치면 fallback 화면(커서가 있는 화면)으로 옮긴다.
export function fitChatBounds(saved: Rect, areas: readonly Rect[], fallback: Rect, min: Size): Rect {
  const best = areas.reduce<{ area: Rect; score: number } | null>((acc, area) => {
    const score = overlap(saved, area);
    return !acc || score > acc.score ? { area, score } : acc;
  }, null);
  const area = best && best.score > 0 ? best.area : fallback;
  const width = Math.min(Math.max(saved.width, Math.min(min.width, area.width)), area.width);
  const height = Math.min(Math.max(saved.height, Math.min(min.height, area.height)), area.height);
  const x = Math.max(area.x, Math.min(saved.x, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(saved.y, area.y + area.height - height));
  return { x, y, width, height };
}

// 저장한 자리가 없을 때(처음 대화로 커질 때): 입력 막대의 윗변 가운데에서 아래로 자란다. 작업 영역을 넘으면 안으로 당긴다.
export function growFromBar(bar: Rect, size: Size, area: Rect): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const x = Math.max(area.x, Math.min(Math.round(bar.x + bar.width / 2 - width / 2), area.x + area.width - width));
  const y = Math.max(area.y, Math.min(bar.y, area.y + area.height - height));
  return { x, y, width, height };
}

// 대화에서 새 미니 대화로: 대화 패널의 윗변 가운데에 입력 막대의 윗변 가운데를 맞춘다.
export function barFromChat(chat: Rect, size: Size, area: Rect): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const x = Math.max(area.x, Math.min(Math.round(chat.x + chat.width / 2 - width / 2), area.x + area.width - width));
  const y = Math.max(area.y, Math.min(chat.y, area.y + area.height - height));
  return { x, y, width, height };
}

// 창 크기(DIP)가 실제로 달라졌나. 같으면 저장하지 않는다.
export const sameRect = (a: Rect | null, b: Rect | null): boolean => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
