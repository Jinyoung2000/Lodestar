import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, Prec, RangeSet, type Extension } from "@codemirror/state";
import { dropCursor, EditorView, GutterMarker, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumberMarkers, lineNumbers, rectangularSelection } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import "./editorShowHover";
import "./editorPresetCommands";
import "./editorViewCommands";
import { editorStatusExtensions } from "./editorStatusState";
import { indentExtension } from "./editorIndent";
import { wrapExtension } from "./editorWrap";
import { lightbulbExtension } from "./editorLightbulb";
import { wordHighlightExtension } from "./editorWordHighlight";
import { renameExtension } from "./renameSymbol";
import { editingExtension } from "./editorEditing";
import { rulerExtension } from "./editorRuler";
import { minimapExtension } from "./editorMinimap";
import { stickyExtension } from "./editorSticky";
import { cursorExtension } from "./editorCursor"; // EDPARITY(D)
import { foldExtension } from "./editorFold"; // EDPARITY(D)
import { indentGuidesExtension } from "./editorGuides"; // EDPARITY(D)
import { scrollExtension } from "./editorScroll"; // EDPARITY(D)
import { selectionExtension } from "./editorSelection"; // EDPARITY(D)
import { bracketColorization } from "./editorSyntax"; // EDPARITY(D)
import { renderWhitespaceExtension } from "./editorWhitespace"; // EDPARITY(D)

export function editorBase(): Extension {
  return [
    highlightSpecialChars(),
    history(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    autocompletion(),
    rectangularSelection(),
    editorStatusExtensions(), // EDPARITY(C)
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, ...lintKeymap]),
  ];
}

// 설정을 확장으로 바꿀 때 쓰는 파일 정보. text 는 만들 때의 본문이거나 다시 만들 때의 현재 본문이다(들여쓰기 감지가 읽는다).
export type OptionContext = { path: string | null; languageId: string | null; text: string };

// 설정에 따라 바뀌는 바탕 확장
export function editorOptionExtensions(options: EditorOptions, context: OptionContext): Extension {
  return [
    options.lineNumbers === "off" ? [] : lineNumbers(options.lineNumbers === "relative" ? { formatNumber: relativeNumber } : {}),
    options.lineNumbers === "relative" ? relativeLineNumberRefresh : [],
    highlightActiveLineGutter(),
    foldExtension(options, context), // EDPARITY(D)
    cursorExtension(options, context), // EDPARITY(D)
    selectionExtension(options, context), // EDPARITY(D)
    indentGuidesExtension(options, context), // EDPARITY(D)
    renderWhitespaceExtension(options, context), // EDPARITY(D)
    scrollExtension(options, context), // EDPARITY(D)
    bracketColorization.of(options.bracketPairColorization), // EDPARITY(D)
    options.matchBrackets === "never" ? [] : bracketMatching(),
    closingExtensions(options),
    options.selectionHighlight ? highlightSelectionMatches() : [],
    options.renderLineHighlight === "line" || options.renderLineHighlight === "all" ? highlightActiveLine() : [],
    wrapExtension(options), // EDPARITY(C)
    indentExtension(options, context), // EDPARITY(B)
    lightbulbExtension(options, context), // EDPARITY(F1)
    wordHighlightExtension(options), // EDPARITY(F1)
    renameExtension, // EDPARITY(F1)
    editingExtension(options, context), // EDPARITY(A)
    rulerExtension(options), // EDPARITY(E)
    minimapExtension(options), // EDPARITY(E)
    stickyExtension(options), // EDPARITY(E)
  ];
}

function relativeNumber(lineNo: number, state: EditorState) {
  const cursorLine = state.doc.lineAt(state.selection.main.head).number;
  return String(lineNo === cursorLine ? lineNo : Math.abs(lineNo - cursorLine));
}

// 줄 번호 거터는 문서, 보이는 범위, 마커 집합이 바뀔 때만 다시 그린다. 커서 줄이 바뀌면 마커 집합을 새로 만들어 다시 그리게 한다.
class NoMarker extends GutterMarker {}
const refreshMarker = new NoMarker();
const relativeLineNumberRefresh = lineNumberMarkers.compute(["selection"], (state) => RangeSet.of([refreshMarker.range(state.doc.lineAt(state.selection.main.head).from)]));

const DEFAULT_PAIRS = ["(", "[", "{", "'", '"'];
const BRACKET_OPENERS = new Set(["(", "[", "{"]);
const BEFORE_BY_MODE: Record<EditorOptions["autoClosingBrackets"], string> = { languageDefined: ";:.,=}])> \n\t", always: "", beforeWhitespace: " \n\t", never: "" };
const ANY_LETTER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$";

export function closingExtensions(options: EditorOptions): Extension {
  if (options.autoClosingBrackets === "never" && options.autoClosingQuotes === "never") return [];
  const modeFor = (opener: string) => (BRACKET_OPENERS.has(opener) ? options.autoClosingBrackets : options.autoClosingQuotes);
  const before = (mode: EditorOptions["autoClosingBrackets"]) => (mode === "always" ? `${BEFORE_BY_MODE.languageDefined}${ANY_LETTER}` : BEFORE_BY_MODE[mode]);
  // before 는 문서 전체에 하나라서 괄호와 따옴표 중 더 느슨한 쪽을 따른다
  const looser = options.autoClosingBrackets === "always" || options.autoClosingQuotes === "always" ? "always" : options.autoClosingBrackets === "never" ? options.autoClosingQuotes : options.autoClosingBrackets;
  const provider = (state: EditorState, pos: number, side: -1 | 0 | 1): readonly { [name: string]: unknown }[] => {
    const others = state.facet(EditorState.languageData).filter((p) => p !== provider);
    let base: { brackets?: string[] } | undefined;
    for (const other of others) {
      base = other(state, pos, side).find((data) => data.closeBrackets)?.closeBrackets as { brackets?: string[] } | undefined;
      if (base) break;
    }
    const brackets = (base?.brackets ?? DEFAULT_PAIRS).filter((opener) => modeFor(opener) !== "never");
    return [{ closeBrackets: { ...base, brackets, before: before(looser) } }];
  };
  return [closeBrackets(), EditorState.languageData.of(provider), surroundFilter(options.autoSurround)];
}

// autoSurround: 선택이 있을 때 여는 글자를 치면 감싸는 것은 closeBrackets 가 늘 한다. 허용하지 않는 종류(never, quotes 만 허용이면 괄호, brackets 만 허용이면 따옴표)는
// 선택을 그 글자로 바꾸는 평범한 입력으로 돌린다. closeBrackets 보다 먼저 받아야 해서 Prec.high.
function surroundFilter(mode: EditorOptions["autoSurround"]): Extension {
  if (mode === "languageDefined") return [];
  const allowed = (char: string) => (mode === "never" ? false : mode === "quotes" ? !BRACKET_OPENERS.has(char) : BRACKET_OPENERS.has(char));
  return Prec.high(
    EditorView.inputHandler.of((view, from, to, text) => {
      if (from === to || text.length !== 1) return false;
      const isPairOpener = BRACKET_OPENERS.has(text) || text === "'" || text === '"' || text === "`";
      if (!isPairOpener || allowed(text)) return false;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + 1 }, userEvent: "input.type" });
      return true;
    }),
  );
}
