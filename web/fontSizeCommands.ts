import { EDITOR_FONT_DEFAULTS, UI_TYPE_DEFAULTS, UI_TYPE_RANGES } from "../shared/protocol";
import { rpc } from "./rpc";
import { getState } from "./store";
import { chatSizePatch } from "./uiType";

export type FontStep = 1 | -1 | 0;

const EDITOR_RANGE = { min: 8, max: 32 };
const clamp = (value: number, range: { min: number; max: number }) => Math.min(range.max, Math.max(range.min, value));

// 순수 함수: 지금 크기와 단계로 다음 크기를 낸다. 0 은 기본값으로 되돌린다.
export function nextFontSize(current: number, step: FontStep, fallback: number, range: { min: number; max: number }): number {
  if (step === 0) return fallback;
  return clamp(Math.round(current) + step, range);
}

export function stepEditorFontSize(step: FontStep) {
  const current = getState().settings?.editorFontSize ?? EDITOR_FONT_DEFAULTS.editorFontSize;
  const size = nextFontSize(current, step, EDITOR_FONT_DEFAULTS.editorFontSize, EDITOR_RANGE);
  if (size !== current) void rpc.call("settings.set", { editorFontSize: size });
}

export function stepChatFontSize(step: FontStep) {
  const settings = getState().settings;
  const current = settings?.chatFontSize ?? UI_TYPE_DEFAULTS.chatFontSize;
  const size = nextFontSize(current, step, UI_TYPE_DEFAULTS.chatFontSize, UI_TYPE_RANGES.chatFontSize);
  if (size !== current) void rpc.call("settings.set", chatSizePatch(settings, size));
}
