import AsyncStorage from "@react-native-async-storage/async-storage";
import { requireOptionalNativeModule } from "expo";
import * as Updates from "expo-updates";
import { AppState, Dimensions, PixelRatio, Platform } from "react-native";

type UploadTarget = { url: string; fields: Record<string, string> };
type SavedLog = { key: string; text: string };
type ExitRecord = { source: "java" | "system"; at?: number; reason?: string; trace?: string | null } & Record<string, unknown>;
type ExitReasons = { takeRecent(): ExitRecord[] };
type HermesHooks = {
  enablePromiseRejectionTracker?(options: { allRejections: boolean; onUnhandled(id: number, error: unknown): void }): void;
  getInstrumentedStats?(): Record<string, unknown>;
};

const MAX_LINES = 800;
const LINE_CHARS = 3000;
const EXIT_CHARS = 12_000;
const SAVE_DELAY_MS = 1000;
const UPLOAD_DELAY_MS = 15_000;
const URGENT_UPLOAD_DELAY_MS = 800;
const HEAP_EVERY_MS = 60_000;
const DEVICE_KEY = "diag:device";
const LOG_KEY = "diag:log";

const launchedAt = new Date();
const lines: string[] = [];
const lastState = new Map<string, string>();
let target: UploadTarget | null = null;
let device: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let uploadTimer: ReturnType<typeof setTimeout> | null = null;
let uploadDueAt = 0;
let started = false;

function readTarget(): UploadTarget | null {
  try {
    const parsed = JSON.parse(process.env.EXPO_PUBLIC_DIAG_UPLOAD ?? "null") as UploadTarget | null;
    return parsed && typeof parsed.url === "string" && parsed.fields && typeof parsed.fields === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function show(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function add(level: string, parts: unknown[], urgent: boolean, maxChars = LINE_CHARS) {
  const stamp = ((Date.now() - launchedAt.getTime()) / 1000).toFixed(2).padStart(8, " ");
  lines.push(`${stamp} ${level} ${parts.map(show).join(" ").slice(0, maxChars)}`);
  if (lines.length > MAX_LINES) lines.splice(100, lines.length - MAX_LINES);
  if (!started) return;
  saveTimer ??= setTimeout(save, SAVE_DELAY_MS);
  scheduleUpload(urgent ? URGENT_UPLOAD_DELAY_MS : UPLOAD_DELAY_MS);
}

export function diag(...parts: unknown[]) {
  add("D", parts, false);
}

export function diagState(name: string, value: string) {
  if (lastState.get(name) === value) return;
  lastState.set(name, value);
  add("S", [`${name} ${value}`], false);
}

const logKey = () => `phone-logs/${device ?? "unknown"}/${launchedAt.toISOString().replace(/[:.]/g, "-")}.txt`;

function save() {
  saveTimer = null;
  const saved: SavedLog = { key: logKey(), text: lines.join("\n") };
  void AsyncStorage.setItem(LOG_KEY, JSON.stringify(saved)).catch(() => {});
}

function scheduleUpload(delay: number) {
  if (!target) return;
  const dueAt = Date.now() + delay;
  if (uploadTimer && uploadDueAt <= dueAt) return;
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadDueAt = dueAt;
  uploadTimer = setTimeout(() => {
    uploadTimer = null;
    void send(logKey(), lines.join("\n"));
  }, delay);
}

async function send(key: string, text: string) {
  if (!target) return;
  const form = new FormData();
  for (const [name, value] of Object.entries(target.fields)) form.append(name, name === "key" ? key : value);
  form.append("file", text);
  await fetch(target.url, { method: "POST", body: form }).catch(() => {});
}

function header() {
  const window = Dimensions.get("window");
  const constants = Platform.constants as { Model?: string; Brand?: string; Release?: string };
  const update = Updates.runtimeVersion ? `${Updates.runtimeVersion} ${Updates.isEmbeddedLaunch ? "built in" : `OTA ${Updates.updateId ?? "unknown"}`}` : "development";
  return `launch ${launchedAt.toISOString()} update=${update} device=${constants.Brand ?? ""} ${constants.Model ?? ""} ${Platform.OS} ${constants.Release ?? Platform.Version} window=${Math.round(window.width)}x${Math.round(window.height)} scale=${PixelRatio.get()} font=${window.fontScale}`;
}

function heap() {
  const stats = (globalThis as { HermesInternal?: HermesHooks }).HermesInternal?.getInstrumentedStats?.();
  if (!stats) return;
  const picked = Object.entries(stats).filter(([name, value]) => typeof value === "number" && /heap|alloc|numGC|gcTime/i.test(name)).map(([name, value]) => `${name}=${value}`);
  add("M", [picked.join(" ")], false);
}

async function start() {
  target = readTarget();
  const [savedDevice, previous] = await Promise.all([AsyncStorage.getItem(DEVICE_KEY).catch(() => null), AsyncStorage.getItem(LOG_KEY).catch(() => null)]);
  device = savedDevice ?? Math.random().toString(16).slice(2, 10);
  if (!savedDevice) void AsyncStorage.setItem(DEVICE_KEY, device).catch(() => {});
  if (previous) {
    try {
      const saved = JSON.parse(previous) as SavedLog;
      void send(saved.key, `${saved.text}\n-- sent at next launch ${launchedAt.toISOString()}`);
    } catch {
      add("D", ["previous log unreadable"], false);
    }
  }
  reportPreviousExits();
  started = true;
  save();
  scheduleUpload(URGENT_UPLOAD_DELAY_MS);
}

const QUIET_EXITS = new Set(["user requested", "user stopped", "package updated", "exit self"]);

function reportPreviousExits() {
  let exits: ExitRecord[] = [];
  try {
    exits = requireOptionalNativeModule<ExitReasons>("LodestarExitReasons")?.takeRecent() ?? [];
  } catch (error) {
    add("D", ["exit reasons unreadable", error], false);
  }
  for (const { trace, at, ...rest } of exits) {
    const when = typeof at === "number" ? new Date(at).toISOString() : "";
    const loud = rest.source === "java" || !QUIET_EXITS.has(String(rest.reason));
    add(loud ? "E" : "D", [`[exit] ${when}`, rest, ...(trace ? [`\n${trace}`] : [])], loud, EXIT_CHARS);
  }
}

export function installDiagLog() {
  if (started || lines.length > 0) return;
  add("D", [header()], false);
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...parts: unknown[]) => {
      add(level === "log" ? "L" : level === "warn" ? "W" : "E", parts, level !== "log");
      original(...parts);
    };
  }
  (globalThis as { HermesInternal?: HermesHooks }).HermesInternal?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id, error) => add("E", ["unhandled rejection", error], true),
  });
  AppState.addEventListener("change", (next) => {
    add("S", [`appState ${next}`], next !== "active");
    if (next !== "active") save();
  });
  setInterval(heap, HEAP_EVERY_MS);
  void start();
}
