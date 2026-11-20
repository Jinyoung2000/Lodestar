// 전역 빠른 입력창의 순수 로직: 단축키 문자열 검증과 표기, 등록 상태 기계, 창 위치와 높이, 빠른 입력창에서 막을 키.
// electron 을 import 하지 않아 test/quickentry.test.ts 가 그대로 돌린다. 실제 등록(globalShortcut)과 창은 electron/quickEntry.ts 가 맡는다.

export const QUICK_ENTRY_DEFAULT_SHORTCUT = "Alt+C";

// --- 단축키 문자열 ---

const MODIFIER_ALIASES: Record<string, "Command" | "CommandOrControl" | "Control" | "Alt" | "Shift"> = {
  command: "Command",
  cmd: "Command",
  meta: "Command",
  super: "Command",
  commandorcontrol: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

// 글자만 치는 것과 구별되려면 Shift 말고 이 수정키 중 하나가 있어야 한다. Shift+C 는 그냥 대문자 C 라서 전역으로 가로채면 모든 앱에서 대문자를 못 친다.
const CHORD_MODIFIERS = new Set(["Command", "CommandOrControl", "Control", "Alt"]);
const MODIFIER_ORDER = ["CommandOrControl", "Command", "Control", "Alt", "Shift"];

const NAMED_KEYS: Record<string, string> = {
  space: "Space",
  tab: "Tab",
  enter: "Enter",
  return: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};
const PUNCTUATION = new Set([",", ".", "/", ";", "'", "[", "]", "\\", "-", "=", "`"]);

function normalizeKey(raw: string): string | null {
  if (/^[a-z]$/i.test(raw)) return raw.toUpperCase();
  if (/^[0-9]$/.test(raw)) return raw;
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(raw);
  if (fn) return `F${fn[1]}`;
  if (PUNCTUATION.has(raw)) return raw;
  // 자기 이름만 본다. 그냥 NAMED_KEYS[...] 면 "Alt+constructor" 가 Object 의 함수를 키로 받아 "Alt+function Object() {...}" 로 통과했다.
  const lower = raw.toLowerCase();
  return Object.hasOwn(NAMED_KEYS, lower) ? NAMED_KEYS[lower] : null;
}

// 설정에 저장하거나 globalShortcut.register 에 넘길 수 있는 모양으로 정리한다. 안 되는 문자열이면 null.
export function parseAccelerator(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const parts = text.split("+").map((p) => p.trim());
  // "Alt++" 처럼 마지막 키가 + 인 표기는 받지 않는다
  if (parts.length < 2 || parts.some((p) => p === "")) return null;
  const key = normalizeKey(parts[parts.length - 1]);
  if (!key) return null;
  const modifiers = new Set<string>();
  for (const part of parts.slice(0, -1)) {
    const modifier = Object.hasOwn(MODIFIER_ALIASES, part.toLowerCase()) ? MODIFIER_ALIASES[part.toLowerCase()] : undefined;
    if (!modifier || modifiers.has(modifier)) return null;
    modifiers.add(modifier);
  }
  if (![...modifiers].some((m) => CHORD_MODIFIERS.has(m))) return null;
  return [...MODIFIER_ORDER.filter((m) => modifiers.has(m)), key].join("+");
}

export type KeyStroke = { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

const CODE_NAMES: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

// 단축키 녹화 입력: 눌린 키를 단축키 문자열로. ⌥C 는 key 가 "ç" 라서 글자는 code(KeyC)에서 읽는다. 수정키만 눌렀거나 쓸 수 없는 조합이면 null.
export function acceleratorFromKeyStroke(stroke: KeyStroke): string | null {
  const code = stroke.code;
  const key = /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit([0-9])$/.exec(code)?.[1] ?? /^F[0-9]{1,2}$/.exec(code)?.[0] ?? CODE_NAMES[code] ?? null;
  if (!key) return null;
  const parts = [stroke.metaKey ? "Command" : null, stroke.ctrlKey ? "Control" : null, stroke.altKey ? "Alt" : null, stroke.shiftKey ? "Shift" : null].filter(Boolean);
  return parseAccelerator([...parts, key].join("+"));
}

const GLYPHS: Record<string, string> = { Control: "⌃", Alt: "⌥", Shift: "⇧", Command: "⌘", CommandOrControl: "⌘", Up: "↑", Down: "↓", Left: "←", Right: "→", Enter: "↵", Backspace: "⌫", Delete: "⌦" };

// 화면에 보이는 표기(macOS 순서 ⌃⌥⇧⌘). Alt+C 는 ⌥C.
export function acceleratorLabel(accelerator: string): string {
  const parts = accelerator.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const order = ["Control", "Alt", "Shift", "Command", "CommandOrControl"];
  const glyphs = order.filter((m) => mods.includes(m)).map((m) => GLYPHS[m]);
  return `${glyphs.join("")}${GLYPHS[key] ?? key}`;
}

// settings.json 에서 읽은 값을 쓸 수 있는 설정으로. 없거나 깨졌으면 기본값(켬, ⌥C).
export type QuickEntryConfig = { enabled: boolean; accelerator: string };

export function normalizeQuickEntryConfig(raw: { enabled?: unknown; accelerator?: unknown } | null | undefined): QuickEntryConfig {
  return { enabled: typeof raw?.enabled === "boolean" ? raw.enabled : true, accelerator: parseAccelerator(raw?.accelerator) ?? QUICK_ENTRY_DEFAULT_SHORTCUT };
}

// --- 등록 상태 ---

// off: 사용자가 껐다. registered: 등록됨. failed: 다른 앱이 쓰고 있거나(taken) 등록할 수 없는 문자열(invalid). blocked: 시험 인스턴스라 일부러 등록하지 않았다.
export type QuickShortcutStatus = { state: "off" | "registered" | "failed" | "blocked"; accelerator: string; reason?: "taken" | "invalid" | "test-instance" };

// 시험 인스턴스는 전역 단축키를 절대 등록하지 않는다(사용자의 실제 ⌥C 를 가로챈다). AGENT_NAV_INACTIVE=1 이거나 창구가 켜진 실행(inactive)이면 자동으로 막힌다.
export function quickShortcutBlocked(env: Record<string, string | undefined>, inactive: boolean): boolean {
  return inactive || env.AGENT_NAV_INACTIVE === "1" || env.AGENT_NAV_NO_GLOBAL_SHORTCUT === "1";
}

export type ShortcutRegistry = {
  register(accelerator: string, onPress: () => void): boolean;
  unregister(accelerator: string): void;
};

// 설정(켬 여부, 단축키)을 받아 등록을 맞춘다. 같은 설정이 다시 오면 등록된 채로 두고, 실패 상태면 다시 시도한다.
export class QuickShortcutController {
  private current: QuickShortcutStatus;
  private registered: string | null = null;
  private lastConfig: QuickEntryConfig | null = null;

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly onPress: () => void,
    private readonly blocked: boolean,
  ) {
    this.current = blocked ? { state: "blocked", accelerator: QUICK_ENTRY_DEFAULT_SHORTCUT, reason: "test-instance" } : { state: "off", accelerator: QUICK_ENTRY_DEFAULT_SHORTCUT };
  }

  get status(): QuickShortcutStatus {
    return this.current;
  }

  apply(config: QuickEntryConfig): QuickShortcutStatus {
    const accelerator = parseAccelerator(config.accelerator);
    if (this.blocked) {
      this.current = { state: "blocked", accelerator: accelerator ?? config.accelerator, reason: "test-instance" };
      return this.current;
    }
    if (!accelerator) {
      this.release();
      this.lastConfig = null;
      this.current = { state: "failed", accelerator: config.accelerator, reason: "invalid" };
      return this.current;
    }
    const same = this.lastConfig && this.lastConfig.enabled === config.enabled && this.lastConfig.accelerator === accelerator;
    if (same && this.current.state === "registered") return this.current;
    this.lastConfig = { enabled: config.enabled, accelerator };
    this.release();
    if (!config.enabled) {
      this.current = { state: "off", accelerator };
      return this.current;
    }
    let ok = false;
    let reason: "taken" | "invalid" = "taken";
    try {
      ok = this.registry.register(accelerator, this.onPress);
    } catch {
      reason = "invalid";
    }
    if (ok) this.registered = accelerator;
    this.current = ok ? { state: "registered", accelerator } : { state: "failed", accelerator, reason };
    return this.current;
  }

  // 앱 종료 때. 등록한 것만 푼다.
  release() {
    if (this.registered) this.registry.unregister(this.registered);
    this.registered = null;
  }
}

// --- 창 위치와 높이 ---

export type Rect = { x: number; y: number; width: number; height: number };

// 커서가 든 화면의 작업 영역(메뉴 막대와 Dock 을 뺀 영역). 어느 화면에도 없으면 가장 가까운 화면.
export function pickWorkArea(areas: readonly Rect[], cursor: { x: number; y: number }): Rect | null {
  if (areas.length === 0) return null;
  const inside = areas.find((a) => cursor.x >= a.x && cursor.x < a.x + a.width && cursor.y >= a.y && cursor.y < a.y + a.height);
  if (inside) return inside;
  const distance = (a: Rect) => {
    const dx = Math.max(a.x - cursor.x, 0, cursor.x - (a.x + a.width));
    const dy = Math.max(a.y - cursor.y, 0, cursor.y - (a.y + a.height));
    return dx * dx + dy * dy;
  };
  return areas.reduce((best, a) => (distance(a) < distance(best) ? a : best));
}

// 화면 위쪽 가운데. 막대(카드) 윗변이 작업 영역 높이의 topRatio 에 오고, 창은 그보다 pad 만큼 위에서 시작한다(shadow 여백).
// 높이가 늘어도 윗변은 그대로이고 아래로만 자란다. 작업 영역을 넘으면 위로 당겨 안에 들게 한다.
export function quickEntryBounds(workArea: Rect, size: { width: number; height: number }, options: { topRatio: number; pad: number }): Rect {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const wanted = Math.round(workArea.y + workArea.height * options.topRatio - options.pad);
  const y = Math.max(workArea.y, Math.min(wanted, workArea.y + workArea.height - height));
  return { x, y, width, height };
}

// 페이지가 잰 내용 높이를 창 높이로. 최소 막대 한 줄, 최대 상한, 작업 영역 높이를 넘지 않는다.
export function clampQuickHeight(wanted: number, limits: { min: number; max: number }, workArea: Rect | null): number {
  const ceiling = workArea ? Math.min(limits.max, workArea.height) : limits.max;
  if (!Number.isFinite(wanted)) return limits.min;
  return Math.round(Math.max(limits.min, Math.min(wanted, ceiling)));
}

// --- 빠른 입력창 안에서 앱 메뉴 가속키가 먹지 않게 ---

export type InputProbe = { key: string; code?: string; meta: boolean; control: boolean; alt: boolean; shift: boolean };

// 빠른 입력창이 포커스일 때 앱 메뉴의 가속키(⌘N, ⌘R, ⌥H 등)는 메인 창에 명령을 보낸다. 창 안에서 쓰는 편집 키만 통과시키고 나머지는 막는다.
// hide: ⌘W 는 메뉴의 닫기 대신 이 창을 숨긴다(쓰던 글이 남는다).
// forward: 미니 대화 입력창 칩이 알리는 ⇧⌘M(모델), ⇧⌘I(effort)는 앱 메뉴 가속키이기도 해서, 메뉴 대신 이 창의 페이지로 넘긴다(web/MiniChat.tsx).
// 글자는 key 가 로마자일 때만 key 로 읽는다. 한글 입력 중의 ⌘C 는 key 가 ㅊ, ⌥H 는 ˙ 라서 물리 키(code)의 글자로 읽는다.
export function quickInputPolicy(input: InputProbe): "allow" | "block" | "hide" | "forward" {
  const named = input.key.toLowerCase();
  const physical = /^Key([A-Z])$/.exec(input.code ?? "");
  const key = /^[a-z]$/.test(named) || !physical ? named : physical[1].toLowerCase();
  if (input.meta) {
    if (key === "w") return "hide";
    if (input.shift && !input.alt && !input.control && (key === "m" || key === "i")) return "forward";
    if (!input.shift && !input.control && /^Digit[1-9]$/.test(input.code ?? "")) return "allow";
    return ["c", "v", "x", "a", "z", "q", "enter", "arrowup", "arrowdown", "arrowleft", "arrowright", "backspace", "delete"].includes(key) ? "allow" : "block";
  }
  if (input.control && input.alt) return "block";
  if (input.alt && key === "h") return "block";
  return "allow";
}
