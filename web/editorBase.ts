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
import { cursorExtension } from "./editorCursor";
import { foldExtension } from "./editorFold";
import { indentGuidesExtension } from "./editorGuides";
import { scrollExtension } from "./editorScroll";
import { selectionExtension } from "./editorSelection";
import { bracketColorization } from "./editorSyntax";
import { renderWhitespaceExtension } from "./editorWhitespace";

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
    editorStatusExtensions(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, ...lintKeymap]),
  ];
}

export type OptionContext = { path: string | null; languageId: string | null; text: string };

export function editorOptionExtensions(options: EditorOptions, context: OptionContext): Extension {
  return [
    options.lineNumbers === "off" ? [] : lineNumbers(options.lineNumbers === "relative" ? { formatNumber: relativeNumber } : {}),
    options.lineNumbers === "relative" ? relativeLineNumberRefresh : [],
    highlightActiveLineGutter(),
    foldExtension(options, context),
    cursorExtension(options, context),
    selectionExtension(options, context),
    indentGuidesExtension(options, context),
    renderWhitespaceExtension(options, context),
    scrollExtension(options, context),
    bracketColorization.of(options.bracketPairColorization),
    options.matchBrackets === "never" ? [] : bracketMatching(),
    closingExtensions(options),
    options.selectionHighlight ? highlightSelectionMatches() : [],
    options.renderLineHighlight === "line" || options.renderLineHighlight === "all" ? highlightActiveLine() : [],
    wrapExtension(options),
    indentExtension(options, context),
    lightbulbExtension(options, context),
    wordHighlightExtension(options),
    renameExtension,
    editingExtension(options, context),
    rulerExtension(options),
    minimapExtension(options),
    stickyExtension(options),
  ];
}

function relativeNumber(lineNo: number, state: EditorState) {
  const cursorLine = state.doc.lineAt(state.selection.main.head).number;
  return String(lineNo === cursorLine ? lineNo : Math.abs(lineNo - cursorLine));
}

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
