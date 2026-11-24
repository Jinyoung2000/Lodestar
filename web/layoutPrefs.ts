import { chatDockOf, type ChatDock } from "./focusLayout";
import { isLayoutMode, parseRect, type FloatRect, type LayoutMode } from "./floatLayout";

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
  }
}

function readMode(key: string): LayoutMode | null {
  const raw = read(key);
  return isLayoutMode(raw) ? raw : null;
}

export const loadLastLayout = () => readMode(LAST_KEY);
export const saveLastLayout = (mode: LayoutMode) => write(LAST_KEY, mode);

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

export const loadCachedPerSession = () => read(PER_SESSION_KEY) !== "0";
export const cachePerSession = (on: boolean) => write(PER_SESSION_KEY, on ? null : "0");

export const loadCachedChatDock = (): ChatDock => chatDockOf(read(CHAT_DOCK_KEY));
export const cacheChatDock = (dock: ChatDock) => write(CHAT_DOCK_KEY, dock === "floating" ? "floating" : null);
