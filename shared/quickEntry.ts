
export const QUICK_ENTRY_DEFAULT_SHORTCUT = "Alt+C";

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
  const lower = raw.toLowerCase();
  return Object.hasOwn(NAMED_KEYS, lower) ? NAMED_KEYS[lower] : null;
}

export function parseAccelerator(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const parts = text.split("+").map((p) => p.trim());
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

export function acceleratorFromKeyStroke(stroke: KeyStroke): string | null {
  const code = stroke.code;
  const key = /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit([0-9])$/.exec(code)?.[1] ?? /^F[0-9]{1,2}$/.exec(code)?.[0] ?? CODE_NAMES[code] ?? null;
  if (!key) return null;
  const parts = [stroke.metaKey ? "Command" : null, stroke.ctrlKey ? "Control" : null, stroke.altKey ? "Alt" : null, stroke.shiftKey ? "Shift" : null].filter(Boolean);
  return parseAccelerator([...parts, key].join("+"));
}

const GLYPHS: Record<string, string> = { Control: "⌃", Alt: "⌥", Shift: "⇧", Command: "⌘", CommandOrControl: "⌘", Up: "↑", Down: "↓", Left: "←", Right: "→", Enter: "↵", Backspace: "⌫", Delete: "⌦" };

export function acceleratorLabel(accelerator: string): string {
  const parts = accelerator.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const order = ["Control", "Alt", "Shift", "Command", "CommandOrControl"];
  const glyphs = order.filter((m) => mods.includes(m)).map((m) => GLYPHS[m]);
  return `${glyphs.join("")}${GLYPHS[key] ?? key}`;
}

export type QuickEntryConfig = { enabled: boolean; accelerator: string };

export function normalizeQuickEntryConfig(raw: { enabled?: unknown; accelerator?: unknown } | null | undefined): QuickEntryConfig {
  return { enabled: typeof raw?.enabled === "boolean" ? raw.enabled : true, accelerator: parseAccelerator(raw?.accelerator) ?? QUICK_ENTRY_DEFAULT_SHORTCUT };
}

export type QuickShortcutStatus = { state: "off" | "registered" | "failed" | "blocked"; accelerator: string; reason?: "taken" | "invalid" | "test-instance" };

export function quickShortcutBlocked(env: Record<string, string | undefined>, inactive: boolean): boolean {
  return inactive || env.AGENT_NAV_INACTIVE === "1" || env.AGENT_NAV_NO_GLOBAL_SHORTCUT === "1";
}

export type ShortcutRegistry = {
  register(accelerator: string, onPress: () => void): boolean;
  unregister(accelerator: string): void;
};

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

  release() {
    if (this.registered) this.registry.unregister(this.registered);
    this.registered = null;
  }
}

export type Rect = { x: number; y: number; width: number; height: number };

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

export function quickEntryBounds(workArea: Rect, size: { width: number; height: number }, options: { topRatio: number; pad: number }): Rect {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const wanted = Math.round(workArea.y + workArea.height * options.topRatio - options.pad);
  const y = Math.max(workArea.y, Math.min(wanted, workArea.y + workArea.height - height));
  return { x, y, width, height };
}

export function clampQuickHeight(wanted: number, limits: { min: number; max: number }, workArea: Rect | null): number {
  const ceiling = workArea ? Math.min(limits.max, workArea.height) : limits.max;
  if (!Number.isFinite(wanted)) return limits.min;
  return Math.round(Math.max(limits.min, Math.min(wanted, ceiling)));
}

export type InputProbe = { key: string; code?: string; meta: boolean; control: boolean; alt: boolean; shift: boolean };

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
