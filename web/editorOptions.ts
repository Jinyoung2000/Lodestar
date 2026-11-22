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

export function saveEditorOption<K extends EditorOptionKey>(key: K, value: EditorOptions[K]) {
  const chosen = sanitizeEditorOptions(getState().settings?.editorOptions);
  void rpc.call("settings.set", { editorOptions: { ...chosen, [key]: value } });
}

export function resetEditorOption(key: EditorOptionKey) {
  const { [key]: _removed, ...rest } = sanitizeEditorOptions(getState().settings?.editorOptions);
  void rpc.call("settings.set", { editorOptions: rest });
}

function applyLetterSpacing(options: EditorOptions) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--editor-letter-spacing", options.letterSpacing === 0 ? "normal" : `${options.letterSpacing}px`);
}

if (typeof document !== "undefined") {
  applyLetterSpacing(currentEditorOptions());
  subscribeEditorOptions(applyLetterSpacing);
}
