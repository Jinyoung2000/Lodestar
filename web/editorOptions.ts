import { EDITOR_OPTION_DEFAULTS, sanitizeEditorOptions, type EditorOptionKey, type EditorOptions } from "../shared/editorOptions";
import { rpc } from "./rpc";
import { getState, subscribe } from "./store";

let cacheKey = "";
let cache: EditorOptions = EDITOR_OPTION_DEFAULTS;

export function currentEditorOptions(): EditorOptions {
  const s = getState();
  const resolved = s.defaults?.editorOptions?.values;
  const key = resolved ? JSON.stringify(resolved) : `chosen:${JSON.stringify(s.settings?.editorOptions ?? {})}`;
  if (key !== cacheKey) {
    cacheKey = key;
    cache = resolved ? { ...EDITOR_OPTION_DEFAULTS, ...resolved } : { ...EDITOR_OPTION_DEFAULTS, ...sanitizeEditorOptions(s.settings?.editorOptions) };
  }
  return cache;
}

// 값이 바뀔 때만 listener 를 부른다(대화 상태가 바뀌는 잦은 갱신에는 부르지 않는다).
export function subscribeEditorOptions(listener: (options: EditorOptions) => void) {
  let last = currentEditorOptions();
  const off = subscribe(() => {
    const next = currentEditorOptions();
    if (next === last) return;
    last = next;
    listener(next);
  });
  return () => void off();
}

// 직접 고른 값 하나를 저장한다. 고른 값 모음 전체를 바꿔 보낸다(데몬이 통째로 교체).
export function saveEditorOption<K extends EditorOptionKey>(key: K, value: EditorOptions[K]) {
  const chosen = sanitizeEditorOptions(getState().settings?.editorOptions);
  void rpc.call("settings.set", { editorOptions: { ...chosen, [key]: value } });
}

export function resetEditorOption(key: EditorOptionKey) {
  const { [key]: _removed, ...rest } = sanitizeEditorOptions(getState().settings?.editorOptions);
  void rpc.call("settings.set", { editorOptions: rest });
}

// editor.letterSpacing 는 CSS 변수로 쓴다(--editor-letter-spacing, 에디터 .cm-scroller 가 읽는다). 값이 바뀌면 Editor 가 같은 구독에서 다시 잰다.
function applyLetterSpacing(options: EditorOptions) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--editor-letter-spacing", options.letterSpacing === 0 ? "normal" : `${options.letterSpacing}px`);
}

if (typeof document !== "undefined") {
  applyLetterSpacing(currentEditorOptions());
  subscribeEditorOptions(applyLetterSpacing);
}
