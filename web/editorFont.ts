import { EDITOR_FONT_DEFAULTS, type Settings } from "../shared/protocol";

// 코드 글꼴 설정(Settings.editorFont*)을 CSS 변수로 <html> 에 덮어쓴다. 변수의 기본값은 styles.css 에서 디자인 시스템 토큰을 가리킨다.
// 변수가 바뀌어도 CodeMirror 는 글자 크기를 다시 재지 않으므로, 쓰는 쪽이 subscribeEditorFont 로 알림을 받아 requestMeasure / fit 한다.

type FontSettings = Pick<Settings, "editorFontFamily" | "editorFontSize" | "editorLineHeight" | "editorLigatures" | "editorFontTerminal">;

const listeners = new Set<() => void>();
export function subscribeEditorFont(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
const notify = () => listeners.forEach((l) => l());

// 글꼴 파일이 늦게 로드되면 글자 폭이 바뀌므로 그때도 다시 잰다.
if (typeof document !== "undefined" && document.fonts) document.fonts.addEventListener("loadingdone", notify);

let lastSignature = "";

export function applyEditorFont(current: Partial<FontSettings> | null | undefined) {
  if (!current) return;
  // 옛 데몬은 새 필드를 안 주므로 기본값으로 채운다.
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
  // 터미널 켜짐 여부처럼 CSS 변수에 안 나타나는 값도 바뀐 것으로 본다.
  if (signature !== lastSignature) {
    lastSignature = signature;
    notify();
  }
}

// "A", B, 'C d' 같은 font-family 목록을 이름 배열로 나눈다.
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

// document.fonts.check 는 설치되지 않은 시스템 글꼴 이름에도 true 를 주므로, 대체 글꼴과 글자 폭이 달라지는지로 판별한다.
// 폭이 같은 우연을 피하려고 서로 다른 두 대체 글꼴(monospace, serif)과 비교한다. @font-face 로 선언된 글꼴(Geist Mono 등)은 선언 여부로 먼저 본다.
export function isFontInstalled(name: string) {
  if (GENERIC.has(name.toLowerCase())) return true;
  for (const face of document.fonts) if (face.family.replace(/^["']|["']$/g, "") === name) return true;
  const quoted = `"${name.replace(/"/g, "")}"`;
  return ["monospace", "serif"].some((fallback) => width(`${PROBE_SIZE}px ${quoted}, ${fallback}`) !== width(`${PROBE_SIZE}px ${fallback}`));
}

// 목록의 첫 번째 글꼴(사용자가 원하는 글꼴)이 없으면 그 이름을 돌려준다. 있으면 null.
export function missingFirstFamily(list: string) {
  const first = parseFamilies(list)[0];
  return first && !isFontInstalled(first) ? first : null;
}
