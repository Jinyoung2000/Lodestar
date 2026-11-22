import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { HoverData } from "./lspHoverData";

export type Range = { from: number; to: number };
export type Preview = { text: string; languageId: string | null; truncated: boolean };
export type Link = Range & { preview: Preview | null; hover: HoverData | null };

const PREVIEW_MAX_LINES = 8;

export const setLink = StateEffect.define<Link | null>();

export const setModifier = StateEffect.define<boolean>();

export const modifierField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setModifier)) return effect.value;
    return value;
  },
});

export const linkField = StateField.define<Link | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setLink)) return effect.value;
    return tr.docChanged ? null : value;
  },
  provide: (field) => EditorView.decorations.from(field, (link): DecorationSet => (link ? Decoration.set([LINK_MARK.range(link.from, link.to)]) : Decoration.none)),
});

const LINK_MARK = Decoration.mark({ class: "cm-definition-link" });

export function sliceDeclaration(lines: string[], startLine: number, endLine: number | null, languageId: string | null): Preview {
  let end = endLine ?? startLine;
  if (endLine === null) {
    let depth = 0;
    for (let i = startLine; i < lines.length && i < startLine + PREVIEW_MAX_LINES; i++) {
      for (const ch of lines[i]!) depth += "([{".includes(ch) ? 1 : ")]}".includes(ch) ? -1 : 0;
      end = i;
      if (depth <= 0) break;
    }
  }
  const truncated = end - startLine + 1 > PREVIEW_MAX_LINES;
  const picked = lines.slice(startLine, Math.min(end, startLine + PREVIEW_MAX_LINES - 1) + 1);
  const indent = Math.min(...picked.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), Infinity);
  const text = picked.map((l) => l.slice(Number.isFinite(indent) ? indent : 0).replace(/\s+$/, "")).join("\n");
  return { text, languageId, truncated };
}

