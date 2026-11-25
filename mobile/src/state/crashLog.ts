import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Updates from "expo-updates";

export type CrashReport = { at: string; update: string; kind: "render" | "fatal" | "rejection"; message: string; stack: string };

const KEY = "diag:lastCrash";
const STACK_CHARS = 6000;

type GlobalErrors = { getGlobalHandler(): (error: unknown, isFatal?: boolean) => void; setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void };

function runningUpdate() {
  if (!Updates.runtimeVersion) return "development";
  return `${Updates.runtimeVersion} ${Updates.isEmbeddedLaunch ? "built in" : `OTA ${Updates.updateId ?? "unknown"}`}`;
}

export function describeCrash(kind: CrashReport["kind"], error: unknown, componentStack?: string | null): CrashReport {
  const known = error instanceof Error ? error : null;
  const stack = [known?.stack, componentStack].filter(Boolean).join("\n\nComponents:").slice(0, STACK_CHARS);
  return { at: new Date().toISOString(), update: runningUpdate(), kind, message: known ? `${known.name}: ${known.message}` : String(error), stack };
}

export function crashText(report: CrashReport) {
  return [`Lodestar phone ${report.kind} error`, report.at, report.update, report.message, report.stack].join("\n");
}

export function recordCrash(report: CrashReport) {
  console.warn(`[crash] ${crashText(report)}`);
  void AsyncStorage.setItem(KEY, JSON.stringify(report)).catch(() => {});
}

export async function loadCrash(): Promise<CrashReport | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CrashReport) : null;
  } catch {
    return null;
  }
}

let installed = false;
export function installCrashRecorder() {
  const errors = (globalThis as { ErrorUtils?: GlobalErrors }).ErrorUtils;
  if (installed || !errors) return;
  installed = true;
  const previous = errors.getGlobalHandler();
  errors.setGlobalHandler((error, isFatal) => {
    if (isFatal) recordCrash(describeCrash("fatal", error));
    previous(error, isFatal);
  });
}
