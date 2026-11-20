const HOLD_MS = 2000;

let held: { key: string; until: number } | null = null;

export function holdEditorFocus(key: string, now = Date.now()) {
  held = { key, until: now + HOLD_MS };
}

export function releaseEditorFocus(key: string) {
  if (held?.key === key) held = null;
}

export function editorFocusHeld(key: string, now = Date.now()): boolean {
  return held !== null && held.key === key && now < held.until;
}
