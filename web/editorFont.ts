import { EDITOR_FONT_DEFAULTS, type Settings } from "../shared/protocol";

type FontSettings = Pick<Settings, "editorFontFamily" | "editorFontSize" | "editorLineHeight" | "editorLigatures" | "editorFontTerminal">;

const listeners = new Set<() => void>();
export function subscribeEditorFont(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
const notify = () => listeners.forEach((l) => l());

if (typeof document !== "undefined" && document.fonts) document.fonts.addEventListener("loadingdone", notify);

let lastSignature = "";

export function applyEditorFont(current: Partial<FontSettings> | null | undefined) {
  if (!current) return;
  const settings: FontSettings = { ...EDITOR_FONT_DEFAULTS, ...current };
  const root = document.documentElement.style;
  const set = (name: string, value: string) => {
    if (root.getPropertyValue(name) !== value) root.setProperty(name, value);
  };
  const signature = JSON.stringify(settings);
  set("--editor-font-family", settings.editorFontFamily);
  set("--editor-font-size", `${settings.editorFontSize}px`);
  set("--editor-line-height", `${settings.editorLineHeight}px`);
  set("--editor-ligatures", settings.editorLigatures ? "normal" : "none");
  set("--editor-feature-settings", settings.editorLigatures ? '"calt" 1, "liga" 1' : '"calt" 0, "liga" 0');
  if (signature !== lastSignature) {
    lastSignature = signature;
    notify();
  }
}

export function parseFamilies(list: string) {
  const names: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^,]+)/g;
  for (const m of list.matchAll(re)) {
    const name = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (name) names.push(name);
  }
  return names;
}

const PROBE_SIZE = 40;
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-monospace", "ui-sans-serif", "ui-serif", "ui-rounded", "math", "emoji", "fangsong", "-apple-system", "blinkmacsystemfont"]);

let canvas: CanvasRenderingContext2D | null = null;
function width(font: string) {
  canvas ??= document.createElement("canvas").getContext("2d");
  if (!canvas) return 0;
  canvas.font = font;
  return canvas.measureText("mmmmmmmmmmlli0O.WwÀ한글").width;
}

export function isFontInstalled(name: string) {
  if (GENERIC.has(name.toLowerCase())) return true;
  for (const face of document.fonts) if (face.family.replace(/^["']|["']$/g, "") === name) return true;
  const quoted = `"${name.replace(/"/g, "")}"`;
  return ["monospace", "serif"].some((fallback) => width(`${PROBE_SIZE}px ${quoted}, ${fallback}`) !== width(`${PROBE_SIZE}px ${fallback}`));
}

export function missingFirstFamily(list: string) {
  const first = parseFamilies(list)[0];
  return first && !isFontInstalled(first) ? first : null;
}
