export const PERMISSION_CATEGORIES = ["location", "camera", "microphone", "sensors", "clipboard", "notifications", "devices"] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];
export type PermissionDecision = "allow" | "deny";
export type PermissionState = PermissionDecision | "ask";

export const PERMISSION_DEFAULTS: Record<PermissionCategory, "ask" | "allow"> = {
  location: "ask",
  camera: "ask",
  microphone: "ask",
  sensors: "allow",
  clipboard: "ask",
  notifications: "ask",
  devices: "allow",
};

const ALWAYS_ALLOWED = new Set(["pointerLock", "keyboardLock", "fullscreen", "clipboard-sanitized-write"]);

const BY_ELECTRON: Record<string, PermissionCategory> = {
  geolocation: "location",
  "geolocation-approximate": "location",
  sensors: "sensors",
  "clipboard-read": "clipboard",
  notifications: "notifications",
  usb: "devices",
  serial: "devices",
  hid: "devices",
};

export const isAlwaysAllowed = (permission: string) => ALWAYS_ALLOWED.has(permission);

// Electron 권한 이름 하나가 어느 범주들에 걸리는지. media 는 요청한 종류(video, audio)에 따라 camera 와 microphone 이고, 종류를 모르면 둘 다다. 모르는 권한은 빈 목록(거절).
export function categoriesFor(permission: string, mediaTypes?: readonly string[]): PermissionCategory[] {
  if (permission === "media") {
    const found = new Set<PermissionCategory>();
    for (const type of mediaTypes ?? []) found.add(type === "video" ? "camera" : "microphone");
    return found.size ? [...found] : ["camera", "microphone"];
  }
  const category = BY_ELECTRON[permission];
  return category ? [category] : [];
}

// 권한을 묻는 주소의 origin. http 와 https 만 관리한다(그 밖은 빈 글).
export function permissionOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

export type PermissionRecord = Record<string, Partial<Record<PermissionCategory, PermissionDecision>>>;

export class PermissionStore {
  private data = new Map<string, Map<PermissionCategory, PermissionDecision>>();

  getDecision(origin: string, category: PermissionCategory): PermissionDecision | undefined {
    return this.data.get(origin)?.get(category);
  }

  // 지금 이 범주를 허용하는가(기록이 있으면 그것, 없으면 기본값).
  isAllowed(origin: string, category: PermissionCategory): boolean {
    return (this.getDecision(origin, category) ?? PERMISSION_DEFAULTS[category]) === "allow";
  }

  stateOf(origin: string, category: PermissionCategory): PermissionState {
    return this.getDecision(origin, category) ?? PERMISSION_DEFAULTS[category];
  }

  // state 가 null 이면 기록을 지워 기본값으로 되돌린다.
  set(origin: string, category: PermissionCategory, state: PermissionDecision | null) {
    if (!origin) return;
    if (state === null) {
      const entries = this.data.get(origin);
      entries?.delete(category);
      if (entries?.size === 0) this.data.delete(origin);
      return;
    }
    const entries = this.data.get(origin) ?? new Map();
    entries.set(category, state);
    this.data.set(origin, entries);
  }

  // 요청 하나의 판정. allow 면 허용, deny 면 거절, ask 면 사용자에게 물어야 한다(범주가 여럿이면 어느 것이든 거절이 우선).
  decide(origin: string, categories: readonly PermissionCategory[]): "allow" | "deny" | "ask" {
    if (!origin || categories.length === 0) return "deny";
    if (categories.every((c) => this.isAllowed(origin, c))) return "allow";
    if (categories.some((c) => this.getDecision(origin, c) === "deny")) return "deny";
    return "ask";
  }

  serialize(): PermissionRecord {
    const out: PermissionRecord = {};
    for (const [origin, entries] of this.data) out[origin] = Object.fromEntries(entries);
    return out;
  }

  // 저장된 값에서 모르는 범주와 값은 버린다.
  hydrate(raw: unknown) {
    this.data.clear();
    if (!raw || typeof raw !== "object") return;
    for (const [origin, entries] of Object.entries(raw as Record<string, unknown>)) {
      if (!origin || !entries || typeof entries !== "object") continue;
      for (const [category, state] of Object.entries(entries as Record<string, unknown>)) {
        if ((PERMISSION_CATEGORIES as readonly string[]).includes(category) && (state === "allow" || state === "deny")) this.set(origin, category as PermissionCategory, state);
      }
    }
  }
}
