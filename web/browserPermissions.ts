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

export function categoriesFor(permission: string, mediaTypes?: readonly string[]): PermissionCategory[] {
  if (permission === "media") {
    const found = new Set<PermissionCategory>();
    for (const type of mediaTypes ?? []) found.add(type === "video" ? "camera" : "microphone");
    return found.size ? [...found] : ["camera", "microphone"];
  }
  const category = BY_ELECTRON[permission];
  return category ? [category] : [];
}

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

  isAllowed(origin: string, category: PermissionCategory): boolean {
    return (this.getDecision(origin, category) ?? PERMISSION_DEFAULTS[category]) === "allow";
  }

  stateOf(origin: string, category: PermissionCategory): PermissionState {
    return this.getDecision(origin, category) ?? PERMISSION_DEFAULTS[category];
  }

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
