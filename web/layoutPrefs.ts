import { chatDockOf, type ChatDock } from "./focusLayout";
import { isLayoutMode, parseRect, type FloatRect, type LayoutMode } from "./floatLayout";

// 배치 모드와 떠 있는 창의 자리를 localStorage 에 남긴다. 저장이 막힌 환경(사생활 보호 창, 미리보기)에서는 이번 실행 동안만 유지하고 화면은 기본값으로 그려진다.
const LAST_KEY = "agent-nav:layout-last";
const DEFAULT_KEY = "agent-nav:layout-default";
const REMEMBER_KEY = "agent-nav:layout-remember";
const RECT_KEY = "agent-nav:float-rect";
const PER_SESSION_KEY = "agent-nav:layout-per-session";
const CHAT_DOCK_KEY = "agent-nav:chat-dock";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 저장이 막혀도 화면은 그대로 동작한다
  }
}

function readMode(key: string): LayoutMode | null {
  const raw = read(key);
  return isLayoutMode(raw) ? raw : null;
}

export const loadLastLayout = () => readMode(LAST_KEY);
export const saveLastLayout = (mode: LayoutMode) => write(LAST_KEY, mode);

// NEWWIN: 지금 앞에 있는 창의 배치. New Window 로 연 빈 창은 이 값으로 시작한다(그 창을 연 창의 배치를 따른다).
const FOCUSED_KEY = "agent-nav:layout-focused";
export const loadFocusedLayout = () => readMode(FOCUSED_KEY);
export const saveFocusedLayout = (mode: LayoutMode) => write(FOCUSED_KEY, mode);

// Settings 는 데몬에서 늦게 오므로 첫 화면은 지난번에 받은 값으로 그린다(Editor 중심 기본값인데 Chat 배치가 잠깐 보이는 것을 막는다).
export const loadCachedDefaultLayout = () => readMode(DEFAULT_KEY);
export const loadCachedRemember = () => read(REMEMBER_KEY) === "1";
export function cacheLayoutSettings(defaultLayout: LayoutMode | null, remember: boolean) {
  write(DEFAULT_KEY, defaultLayout);
  write(REMEMBER_KEY, remember ? "1" : null);
}

export function loadFloatRect(): FloatRect | null {
  const raw = read(RECT_KEY);
  if (!raw) return null;
  try {
    return parseRect(JSON.parse(raw));
  } catch {
    return null;
  }
}
export const saveFloatRect = (rect: FloatRect | null) => write(RECT_KEY, rect ? JSON.stringify(rect) : null);

// PERLAYOUT: 세션별 배치 기억 스위치. Settings 가 늦게 오므로 첫 화면은 지난번에 받은 값으로 정한다. 값이 없으면 켜짐(기본).
export const loadCachedPerSession = () => read(PER_SESSION_KEY) !== "0";
export const cachePerSession = (on: boolean) => write(PER_SESSION_KEY, on ? null : "0");

// Settings 의 "Chat in editor layout". Settings 가 늦게 오므로 첫 화면은 지난번에 받은 값으로 그린다(Docked 가 기본이라 Floating 일 때만 적어 둔다).
export const loadCachedChatDock = (): ChatDock => chatDockOf(read(CHAT_DOCK_KEY));
export const cacheChatDock = (dock: ChatDock) => write(CHAT_DOCK_KEY, dock === "floating" ? "floating" : null);
