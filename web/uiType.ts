import { UI_TYPE_DEFAULTS, type Settings } from "../shared/protocol";

// UI 글자 설정(Settings.uiLetterSpacing 등)을 CSS 변수로 <html> 에 덮어쓴다. 변수의 기본값은 styles.css 와 tokens.css 에 있다.
// 에디터 글꼴(editorFont.ts)과 달리 CodeMirror 가 다시 재야 하는 값이 없어 알림 구독은 두지 않는다.

type UiTypeSettings = Pick<Settings, "uiLetterSpacing" | "uiFontFamily" | "chatFontSize" | "chatLineHeight">;

// 순수 함수: 설정 값을 CSS 변수 이름과 값으로 바꾼다. 옛 데몬이 새 필드를 안 주면 기본값으로 채운다.
export function uiTypeVars(current: Partial<UiTypeSettings> | null | undefined): Record<string, string> {
  const settings: UiTypeSettings = { ...UI_TYPE_DEFAULTS, ...current };
  return {
    "--ui-letter-spacing": `${settings.uiLetterSpacing}em`,
    "--font-sans": settings.uiFontFamily,
    "--text-chat": `${settings.chatFontSize}px`,
    "--leading-chat": `${settings.chatLineHeight}px`,
  };
}

// 기본 줄 높이는 글자 크기의 1.5배(13px 에 19.5px)다. 0.5px 단위로 맞춘다.
export const chatLineHeightFor = (fontSize: number) => Math.round(fontSize * 3) / 2;

// 글자 크기를 바꾸는 저장 값. 줄 높이가 지금 크기의 기본 비율을 따르고 있었으면 같이 옮기고, 직접 정한 줄 높이는 그대로 둔다(dogfood 25).
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
