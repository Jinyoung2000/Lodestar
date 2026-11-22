import { UI_TYPE_DEFAULTS, type Settings } from "../shared/protocol";

type UiTypeSettings = Pick<Settings, "uiLetterSpacing" | "uiFontFamily" | "chatFontSize" | "chatLineHeight">;

export function uiTypeVars(current: Partial<UiTypeSettings> | null | undefined): Record<string, string> {
  const settings: UiTypeSettings = { ...UI_TYPE_DEFAULTS, ...current };
  return {
    "--ui-letter-spacing": `${settings.uiLetterSpacing}em`,
    "--font-sans": settings.uiFontFamily,
    "--text-chat": `${settings.chatFontSize}px`,
    "--leading-chat": `${settings.chatLineHeight}px`,
    "--chat-font-scale": String(settings.chatFontSize / UI_TYPE_DEFAULTS.chatFontSize),
    "--chat-line-height-scale": String(settings.chatLineHeight / UI_TYPE_DEFAULTS.chatLineHeight),
  };
}

export const chatLineHeightFor = (fontSize: number) => Math.round(fontSize * 3) / 2;

export function chatSizePatch(current: Partial<UiTypeSettings> | null | undefined, size: number): Partial<UiTypeSettings> {
  const now = { ...UI_TYPE_DEFAULTS, ...current };
  return now.chatLineHeight === chatLineHeightFor(now.chatFontSize) ? { chatFontSize: size, chatLineHeight: chatLineHeightFor(size) } : { chatFontSize: size };
}

export function applyUiType(current: Partial<UiTypeSettings> | null | undefined) {
  if (!current) return;
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(uiTypeVars(current))) {
    if (root.getPropertyValue(name) !== value) root.setProperty(name, value);
  }
}
