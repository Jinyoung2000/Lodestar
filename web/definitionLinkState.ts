import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { HoverData } from "./lspHoverData";

// ⌘ hover 정의 링크의 상태(밑줄을 칠 범위와 미리보기). 컨트롤러와 툴팁은 web/definitionLink.ts, 여기는 DOM 이 없어 단위 시험이 읽는다.

export type Range = { from: number; to: number };
export type Preview = { text: string; languageId: string | null; truncated: boolean };
// hover 는 같은 자리의 일반 hover 내용(HTML, LSP 가 준 것을 정리한 것). ⌘ 상태에서는 hover 와 미리보기를 한 상자에 담는다.
export type Link = Range & { preview: Preview | null; hover: HoverData | null };

const PREVIEW_MAX_LINES = 8;

export const setLink = StateEffect.define<Link | null>();

// ⌘(Ctrl)가 눌려 있는지. 눌린 동안은 일반 hover 상자를 띄우지 않는다(정의 링크가 생기면 그 상자가 hover 내용까지 담는다).
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
    // 글이 바뀌면 범위가 어긋나므로 지운다(다음 마우스 이동에서 다시 계산).
    return tr.docChanged ? null : value;
  },
  provide: (field) => EditorView.decorations.from(field, (link): DecorationSet => (link ? Decoration.set([LINK_MARK.range(link.from, link.to)]) : Decoration.none)),
});

const LINK_MARK = Decoration.mark({ class: "cm-definition-link" });

// LocationLink 의 targetRange 는 선언 전체이므로 그대로 쓰고, 식별자 범위만 오는 Location 은 괄호가 닫힐 때까지 이어 붙인다.
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

