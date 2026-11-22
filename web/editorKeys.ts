export type SuggestContext = {
  suggestOpen: boolean;
  signatureOpen: boolean;
  signatureMultiple: boolean;
};

export type KeyAction = "closeSignature" | "toggleDetails" | "triggerSuggest" | "nextSuggestion" | "prevSuggestion" | "nextSignature" | "prevSignature" | "pass";

export function spaceKeyAction(key: "ctrl-space" | "cmd-i", ctx: SuggestContext): KeyAction {
  if (ctx.suggestOpen) return "toggleDetails";
  return key === "ctrl-space" ? "triggerSuggest" : "pass";
}

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

export function signatureContext(root: ParentNode, suggestOpen: boolean): SuggestContext {
  const tooltip = root.querySelector(".cm-lsp-signature-tooltip");
  return { suggestOpen, signatureOpen: !!tooltip, signatureMultiple: !!tooltip?.classList.contains("cm-lsp-signature-multiple") };
}
