export type SuggestContext = {
  // 제안 목록이 열려 있다(completionStatus 가 active)
  suggestOpen: boolean;
  // 파라미터 힌트 상자가 떠 있다
  signatureOpen: boolean;
  // 파라미터 힌트에 오버로드가 둘 이상이다
  signatureMultiple: boolean;
};

export type KeyAction = "closeSignature" | "toggleDetails" | "triggerSuggest" | "nextSuggestion" | "prevSuggestion" | "nextSignature" | "prevSignature" | "pass";

// ⌃Space: 제안이 열려 있으면 상세 토글, 아니면 제안 열기. ⌘I 는 닫혀 있을 때 앱의 빠른 질문 키라 열려 있을 때만 상세 토글이다.
export function spaceKeyAction(key: "ctrl-space" | "cmd-i", ctx: SuggestContext): KeyAction {
  if (ctx.suggestOpen) return "toggleDetails";
  return key === "ctrl-space" ? "triggerSuggest" : "pass";
}

// Esc: 제안 목록이 열려 있으면 그것을 닫는 것은 CodeMirror 기본 키맵이 하고(pass), 목록이 없고 파라미터 힌트만 떠 있으면 힌트를 닫는다.
export function escapeAction(ctx: SuggestContext): KeyAction {
  return !ctx.suggestOpen && ctx.signatureOpen ? "closeSignature" : "pass";
}

export type Arrow = { direction: "up" | "down"; via: "plain" | "alt" | "ctrl" };

export function arrowAction(arrow: Arrow, ctx: SuggestContext): KeyAction {
  const down = arrow.direction === "down";
  if (arrow.via === "plain") {
    if (ctx.suggestOpen) return "pass";
    return ctx.signatureOpen && ctx.signatureMultiple ? (down ? "nextSignature" : "prevSignature") : "pass";
  }
  if (arrow.via === "ctrl" && ctx.suggestOpen) return down ? "nextSuggestion" : "prevSuggestion";
  return ctx.signatureOpen && ctx.signatureMultiple ? (down ? "nextSignature" : "prevSignature") : "pass";
}

// 위젯 DOM 으로 맥락을 읽는다. @codemirror/lsp-client 는 파라미터 힌트 상태를 밖으로 내보내지 않고, 상자에 오버로드가 둘 이상이면 cm-lsp-signature-multiple 클래스를 붙인다.
export function signatureContext(root: ParentNode, suggestOpen: boolean): SuggestContext {
  const tooltip = root.querySelector(".cm-lsp-signature-tooltip");
  return { suggestOpen, signatureOpen: !!tooltip, signatureMultiple: !!tooltip?.classList.contains("cm-lsp-signature-multiple") };
}
