import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import { announce } from "./announce";
import { clipboardHandlers } from "./editorClipboard";
import { registerEditorCommands, type EditorCommand } from "./editorCommands";
import { docCommentCloser, enterWithRules, trimAutoWhitespace } from "./editorEnter";
import {
  addCommentLine,
  deleteDuplicateLines,
  duplicateSelection,
  expandLineSelection,
  joinLines,
  removeCommentLine,
  sortLines,
  transformSelection,
  trimTrailingWhitespace,
  type Transform,
} from "./editorLineOps";
import {
  addCursorsToLineEnds,
  addSelectionToPreviousFindMatch,
  cancelSelectionAnchor,
  columnSelect,
  columnSelection,
  cursorWordPart,
  deleteWordPart,
  findSession,
  moveSelectionToNextFindMatch,
  moveSelectionToPreviousFindMatch,
  removeBrackets,
  selectAllOccurrences,
  selectFromAnchorToCursor,
  selectionAnchor,
  setSelectionAnchor,
  type ColumnMove,
} from "./editorSelectOps";
import { expandSelection, shrinkSelection, smartSelectStack } from "./editorSmartSelect";
import "./editorEditing.css";

export function editingExtension(options: EditorOptions, context: { languageId: string | null } = { languageId: null }): Extension {
  return [
    selectionAnchor,
    findSession,
    columnSelection,
    smartSelectStack,
    Prec.high(
      keymap.of([
        { key: "Enter", run: enterWithRules(context.languageId) },
        { key: "Mod-Shift-l", run: () => true },
        { key: "Ctrl-Shift-ArrowRight", run: () => true },
        { key: "Ctrl-Shift-ArrowLeft", run: () => true },
        { key: "Escape", run: cancelSelectionAnchor },
      ]),
    ),
    clipboardHandlers(options),
    docCommentCloser(options, context.languageId),
    trimAutoWhitespace(options),
  ];
}

const TRANSFORMS: [Transform, string][] = [
  ["uppercase", "Transform to Uppercase"],
  ["lowercase", "Transform to Lowercase"],
  ["titlecase", "Transform to Title Case"],
  ["snakecase", "Transform to Snake Case"],
  ["camelcase", "Transform to Camel Case"],
  ["pascalcase", "Transform to Pascal Case"],
  ["kebabcase", "Transform to Kebab Case"],
];

const COLUMN_MOVES: [ColumnMove, string][] = [
  ["left", "Column Selection Left"],
  ["right", "Column Selection Right"],
  ["up", "Column Selection Up"],
  ["down", "Column Selection Down"],
  ["pageUp", "Column Selection Page Up"],
  ["pageDown", "Column Selection Page Down"],
];

function pageSizeOf(view: EditorView): number {
  return Math.max(1, Math.floor(view.scrollDOM.clientHeight / view.defaultLineHeight) - 2);
}

function inFindInput(): boolean {
  return !!document.activeElement?.closest(".cm-find");
}

function setSelectionAnchorWithNotice(view: EditorView): boolean {
  const done = setSelectionAnchor(view);
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  announce(`Anchor set at ${line.number}:${head - line.from + 1}`);
  return done;
}

registerEditorCommands([
  { id: "joinLines", title: "Join Lines", run: joinLines },
  { id: "addCommentLine", title: "Add Line Comment", run: addCommentLine },
  { id: "removeCommentLine", title: "Remove Line Comment", run: removeCommentLine },
  { id: "trimTrailingWhitespace", title: "Trim Trailing Whitespace", run: trimTrailingWhitespace },
  { id: "smartSelectExpand", title: "Expand Selection", run: expandSelection },
  { id: "smartSelectShrink", title: "Shrink Selection", run: shrinkSelection },
  { id: "selectHighlights", title: "Select All Occurrences of Find Match", run: (view) => !inFindInput() && selectAllOccurrences(view) },
  { id: "changeAll", title: "Change All Occurrences", run: (view) => !view.state.readOnly && !inFindInput() && selectAllOccurrences(view) },
  { id: "moveSelectionToNextFindMatch", title: "Move Last Selection to Next Find Match", run: moveSelectionToNextFindMatch },
  { id: "moveSelectionToPreviousFindMatch", title: "Move Last Selection to Previous Find Match", run: moveSelectionToPreviousFindMatch },
  { id: "addSelectionToPreviousFindMatch", title: "Add Selection to Previous Find Match", run: addSelectionToPreviousFindMatch },
  { id: "insertCursorAtEndOfEachLineSelected", title: "Add Cursors to Line Ends", run: addCursorsToLineEnds },
  { id: "removeBrackets", title: "Remove Brackets", run: removeBrackets },
  { id: "setSelectionAnchor", title: "Set Selection Anchor", run: setSelectionAnchorWithNotice },
  { id: "selectFromAnchorToCursor", title: "Select from Anchor to Cursor", run: selectFromAnchorToCursor },
  { id: "cancelSelectionAnchor", title: "Cancel Selection Anchor", run: cancelSelectionAnchor },
  { id: "cursorWordPartLeft", title: "Cursor Word Part Left", run: cursorWordPart(false, false) },
  { id: "cursorWordPartLeftSelect", title: "Cursor Word Part Left Select", run: cursorWordPart(false, true) },
  { id: "cursorWordPartRight", title: "Cursor Word Part Right", run: cursorWordPart(true, false) },
  { id: "cursorWordPartRightSelect", title: "Cursor Word Part Right Select", run: cursorWordPart(true, true) },
  { id: "deleteWordPartLeft", title: "Delete Word Part Left", run: deleteWordPart(false) },
  { id: "deleteWordPartRight", title: "Delete Word Part Right", run: deleteWordPart(true) },
  { id: "sortLinesAscending", title: "Sort Lines Ascending", run: sortLines(false) },
  { id: "sortLinesDescending", title: "Sort Lines Descending", run: sortLines(true) },
  { id: "removeDuplicateLines", title: "Delete Duplicate Lines", run: deleteDuplicateLines },
  { id: "duplicateSelection", title: "Duplicate Selection", run: duplicateSelection },
  { id: "expandLineSelection", title: "Expand Line Selection", run: expandLineSelection },
  ...TRANSFORMS.map(([kind, title]): EditorCommand => ({ id: `transformTo${kind[0].toUpperCase()}${kind.slice(1)}`, title, run: transformSelection(kind) })),
  ...COLUMN_MOVES.map(([move, title]): EditorCommand => ({ id: `columnSelect${move[0].toUpperCase()}${move.slice(1)}`, title, run: (view) => columnSelect(move, pageSizeOf(view))(view) })),
]);
