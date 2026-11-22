import { insertNewlineAndIndent } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { EditorSelection, EditorState, Text, type Extension, type Transaction } from "@codemirror/state";
import { EDITOR_OPTION_DEFAULTS } from "../shared/editorOptions";
import { copyPayload, cutChanges, pasteSpec } from "../web/editorClipboard";
import { autoWhitespaceLines, enterWithRules, matchEnterRule, enterRulesFor, trimAutoWhitespace } from "../web/editorEnter";
import { addCommentLine, deleteDuplicateLines, duplicateSelection, expandLineSelection, joinLines, removeCommentLine, sortLines, transformSelection, transformText, trimTrailingWhitespace, type Target } from "../web/editorLineOps";
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
  removeBrackets,
  selectAllOccurrences,
  selectFromAnchorToCursor,
  selectionAnchor,
  setSelectionAnchor,
} from "../web/editorSelectOps";
import { expandSelection, shrinkSelection, smartSelectStack } from "../web/editorSmartSelect";
import { wordPartLeft, wordPartRight } from "../web/editorWordPart";
import { BINDINGS, stepKey, type KeyContext, type Pending } from "../web/keymap";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const eq = (name: string, actual: unknown, expected: unknown) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} 기대 ${JSON.stringify(expected)}`);

const SESSION_FIELDS: Extension[] = [EditorState.allowMultipleSelections.of(true), selectionAnchor, findSession, columnSelection, smartSelectStack];

function stateOf(doc: string, anchor: number, head = anchor, extensions: Extension[] = []): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [javascript({ typescript: true }), ...SESSION_FIELDS, ...extensions] });
}

function run(command: (target: never) => boolean, state: EditorState): { ok: boolean; state: EditorState } {
  let current = state;
  const target: Target = {
    get state() {
      return current;
    },
    dispatch: (tr: Transaction) => {
      current = tr.state;
    },
  };
  const ok = command(target as never);
  return { ok, state: current };
}

const text = (state: EditorState) => state.doc.toString();
const sel = (state: EditorState) => state.selection.ranges.map((r) => [r.anchor, r.head]);

{
  const enter = enterWithRules("typescript") as unknown as (target: never) => boolean;
  const doc = "/** */";
  let result = run(enter, stateOf(doc, 3));
  eq("/** 와 */ 사이 Enter 는 가운데 줄과 닫는 줄을 만든다", text(result.state), "/**\n * \n */");
  eq("커서는 가운데 줄의 ' * ' 뒤", result.state.selection.main.head, 7);

  result = run(enter, stateOf("/**", 3));
  eq("/** 뒤 Enter 는 ' * ' 줄 하나", text(result.state), "/**\n * ");

  result = run(enter, stateOf("/**\n * foo", 10));
  eq("' * foo' 뒤 Enter 는 ' * ' 를 잇는다", text(result.state), "/**\n * foo\n * ");

  result = run(enter, stateOf("/**\n * foo\n */", 14));
  eq("' */' 뒤 Enter 는 들여쓰기를 한 칸 줄인다(블록 시작과 같은 열)", text(result.state), "/**\n * foo\n */\n");

  result = run(enter, stateOf("  /**\n   * a\n   */", 18));
  eq("들여쓰기 안의 ' */' 뒤 Enter", text(result.state), "  /**\n   * a\n   */\n  ");

  result = run(enter, stateOf("// foo bar", 7));
  eq("줄 주석 한가운데 Enter 는 '// ' 를 잇는다", text(result.state), "// foo \n// bar");

  result = run(enter, stateOf("const a = 1;", 12));
  check("규칙에 안 맞는 줄은 기본 Enter 에 넘긴다(false)", result.ok === false);

  const markdown = run(enterWithRules("markdown") as unknown as (target: never) => boolean, stateOf("/**", 3));
  check("규칙이 없는 언어는 false", markdown.ok === false);

  const tsRules = enterRulesFor("typescript");
  check("미리 닫힌 /** */ 줄 끝은 /** 규칙에 안 맞는다", matchEnterRule(tsRules, "", "/** foo */", "") === null);
  check("java 도 같은 규칙", enterRulesFor("java").length > 0 && enterRulesFor("go").length === 1);
}

{
  const trimExt = trimAutoWhitespace({ ...EDITOR_OPTION_DEFAULTS, trimAutoWhitespace: true });
  const base = "function f() {\n  return 1;\n}";
  const enterAt = (state: EditorState) => run(insertNewlineAndIndent as unknown as (target: never) => boolean, state).state;
  const type = (state: EditorState, pos: number, ch: string) => state.update({ changes: { from: pos, insert: ch }, selection: { anchor: pos + ch.length }, userEvent: "input.type" }).state;
  const moveTo = (state: EditorState, pos: number) => state.update({ selection: { anchor: pos }, userEvent: "select" }).state;

  let state = enterAt(stateOf(base, 14, 14, [trimExt]));
  eq("Enter 가 만든 줄은 추적한다", state.field(autoWhitespaceLines).length, 1);
  const afterMove = moveTo(state, state.doc.length);
  eq("커서를 옮기기만 해서는 지우지 않는다", text(afterMove), text(state));
  const typed = type(afterMove, afterMove.doc.length, "z");
  eq("다른 곳에서 다음 편집을 하면 공백만 있던 줄이 비워진다", text(typed), "function f() {\n\n  return 1;\n}z");
  eq("지운 뒤에는 추적이 비어 있다", typed.field(autoWhitespaceLines).length, 0);

  const head = state.selection.main.head;
  const plainEnter = state.update({ changes: { from: head, insert: "\n  " }, selection: { anchor: head + 3 }, userEvent: "input" }).state;
  eq("줄 끝에 줄바꿈을 끼우는 Enter 도 이전 자동 공백 줄을 비운다", text(plainEnter), "function f() {\n\n  \n  return 1;\n}");
  eq("커서는 새 줄 들여쓰기 뒤", plainEnter.selection.main.head, 18);

  const onLine = type(state, state.selection.main.head, "x");
  eq("그 줄에 글자를 치면 공백을 지우지 않는다", text(onLine), "function f() {\n  x\n  return 1;\n}");

  const twice = enterAt(enterAt(stateOf(base, 14, 14, [trimExt])));
  eq("Enter 를 두 번 누르면 첫 빈 줄이 비워진다", text(twice), "function f() {\n\n  \n  return 1;\n}");

  const offBase = enterAt(stateOf(base, 14, 14, [trimAutoWhitespace({ ...EDITOR_OPTION_DEFAULTS, trimAutoWhitespace: false })]));
  const offTyped = type(moveTo(offBase, offBase.doc.length), offBase.doc.length, "z");
  eq("설정이 꺼지면 공백을 지우지 않는다", text(offTyped), "function f() {\n  \n  return 1;\n}z");

  let typedSpaces = stateOf("a\n\nb", 2, 2, [trimExt]);
  typedSpaces = type(typedSpaces, 2, "  ");
  typedSpaces = moveTo(typedSpaces, typedSpaces.doc.length);
  typedSpaces = type(typedSpaces, typedSpaces.doc.length, "c");
  eq("직접 친 공백은 지우지 않는다", text(typedSpaces), "a\n  \nbc");

  const far = state.update({ changes: { from: 0, insert: "// " }, selection: { anchor: state.doc.length }, userEvent: "input.type" }).state;
  check("커서와 상관없는 곳의 편집이면 공백을 남긴다", text(far).split("\n")[1] === "  ", JSON.stringify(text(far)));
}

{
  const doc = "one\ntwo\nthree";
  const copy = copyPayload(stateOf(doc, 5), true);
  eq("선택이 없으면 현재 줄을 줄바꿈까지 복사", copy?.text, "two\n");
  check("줄 복사 표시", copy?.fromEmptySelection === true);
  check("emptySelectionClipboard 가 꺼지면 복사하지 않는다", copyPayload(stateOf(doc, 5), false) === null);
  eq("선택이 있으면 선택한 글", copyPayload(stateOf(doc, 0, 3), true)?.text, "one");
  const multi = copyPayload(EditorState.create({ doc, selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.range(4, 7), EditorSelection.cursor(9)], 0), extensions: SESSION_FIELDS }), true);
  eq("커서와 선택이 섞이면 줄과 선택을 모두 담는다", multi?.multicursorText, ["one\n", "two", "three\n"]);

  const cutMiddle = EditorState.create({ doc, selection: { anchor: 5 } });
  eq("가운데 줄 잘라내기는 줄바꿈까지", cutChanges(cutMiddle, true), [{ from: 4, to: 8 }]);
  eq("마지막 줄 잘라내기는 앞 줄바꿈까지", cutChanges(EditorState.create({ doc, selection: { anchor: 10 } }), true), [{ from: 7, to: 13 }]);
  eq("한 줄뿐인 문서는 그 줄만", cutChanges(EditorState.create({ doc: "abc", selection: { anchor: 1 } }), true), [{ from: 0, to: 3 }]);

  const pasteState = stateOf(doc, 5);
  let pasted = pasteState.update(pasteSpec(pasteState, "X\n", { text: "X\n", fromEmptySelection: true, multicursorText: null }, true)).state;
  eq("줄 복사한 글은 커서 줄 위에 들어간다", text(pasted), "one\nX\ntwo\nthree");
  eq("커서는 원래 글자 위에 그대로", pasted.selection.main.head, 7);
  pasted = pasteState.update(pasteSpec(pasteState, "X\n", null, true)).state;
  eq("줄 복사 표시가 없으면 커서 자리에 넣는다", text(pasted), "one\ntX\nwo\nthree");

  const cursors = EditorState.create({ doc: "a\nb\nc", selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3), EditorSelection.cursor(5)], 0), extensions: SESSION_FIELDS });
  eq("줄 수가 커서 수와 같으면 한 줄씩 나눠 넣는다", text(cursors.update(pasteSpec(cursors, "1\n2\n3", null, true)).state), "a1\nb2\nc3");
  eq("끝 줄바꿈 하나는 줄 수에서 뺀다", text(cursors.update(pasteSpec(cursors, "1\n2\n3\n", null, true)).state), "a1\nb2\nc3");
  eq("줄 수가 다르면 모든 커서에 통째로", text(cursors.update(pasteSpec(cursors, "1\n2", null, true)).state), "a1\n2\nb1\n2\nc1\n2");
  const meta = { text: "x", fromEmptySelection: false, multicursorText: ["p\nq", "r", "s"] };
  eq("복사할 때 선택마다 담은 글은 줄 수와 상관없이 나눠 넣는다", text(cursors.update(pasteSpec(cursors, "p\nq\nr\ns", meta, true)).state), "ap\nq\nbr\ncs");
}

{
  eq("커서만 있으면 다음 줄을 한 칸 띄워 잇고 커서는 이은 자리", (() => {
    const r = run(joinLines, stateOf("a\n  b\nc", 0)).state;
    return [text(r), r.selection.main.head];
  })(), ["a b\nc", 1]);
  eq("여러 줄 선택은 선택 끝까지 잇는다", text(run(joinLines, stateOf("a\n  b\n  c\nd", 0, 9)).state), "a b c\nd");
  eq("뒤 공백이 있는 줄은 한 칸으로 줄여 잇는다", text(run(joinLines, stateOf("a   \nb", 0)).state), "a b");
  eq("빈 줄과 합치면 그 줄이 사라진다", text(run(joinLines, stateOf("a\n\nb", 0)).state), "a\nb");
  eq("마지막 줄에서는 문서가 그대로이고 커서는 줄 끝", (() => {
    const r = run(joinLines, stateOf("a\nb", 2)).state;
    return [text(r), r.selection.main.head];
  })(), ["a\nb", 3]);
  eq("커서가 여럿이면 각 줄을 잇는다", (() => {
    const s = EditorState.create({ doc: "a\nb\n\nc\nd", selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(5)], 0), extensions: SESSION_FIELDS });
    return text(run(joinLines, s).state);
  })(), "a b\n\nc d");
}

{
  let state = run(addCommentLine, stateOf("  foo\n  bar", 0, 11)).state;
  eq("줄 주석 추가는 가장 얕은 들여쓰기에 붙인다", text(state), "  // foo\n  // bar");
  state = stateOf(text(state), 0, text(state).length);
  eq("이미 주석인 줄에도 한 겹 더 붙인다(ForceAdd)", text(run(addCommentLine, state).state), "  // // foo\n  // // bar");
  eq("줄 주석 제거는 한 겹만 걷는다", text(run(removeCommentLine, stateOf("  // // foo\n  // bar", 0, 19)).state), "  // foo\n  bar");
  eq("끝 공백 제거", text(run(trimTrailingWhitespace, stateOf("a  \n\tb\t\nc", 0)).state), "a\n\tb\nc");
  eq("끝 공백이 없으면 아무것도 안 한다", run(trimTrailingWhitespace, stateOf("a\nb", 0)).ok, false);
}

{
  eq("선택 줄 오름차순 정렬", text(run(sortLines(false), stateOf("c\nb\na\nz", 0, 5)).state), "a\nb\nc\nz");
  eq("선택이 한 줄이면 문서 전체를 내림차순 정렬", text(run(sortLines(true), stateOf("b\nc\na", 0)).state), "c\nb\na");
  eq("이미 정렬되어 있으면 아무것도 안 한다", run(sortLines(false), stateOf("a\nb", 0)).ok, false);
  eq("끝 열이 1 이면 마지막 줄을 뺀다", text(run(sortLines(false), stateOf("c\nb\na", 0, 4)).state), "b\nc\na");
  eq("중복 줄 지우기", text(run(deleteDuplicateLines, stateOf("a\nb\na\nc\nb", 0)).state), "a\nb\nc");
  eq("선택 줄만 중복 제거", text(run(deleteDuplicateLines, stateOf("a\na\nb\nb", 0, 3)).state), "a\nb\nb");
  eq("커서만 있으면 줄 복제, 커서는 복제본으로", (() => {
    const r = run(duplicateSelection, stateOf("ab\ncd", 1)).state;
    return [text(r), r.selection.main.head];
  })(), ["ab\nab\ncd", 4]);
  eq("선택이 있으면 선택 뒤에 복제하고 복제본을 선택", (() => {
    const r = run(duplicateSelection, stateOf("abcd", 1, 3)).state;
    return [text(r), sel(r)];
  })(), ["abcbcd", [[3, 5]]]);
  eq("줄 선택 확장", sel(run(expandLineSelection, stateOf("one\ntwo\nthree", 5)).state), [[4, 8]]);
  eq("마지막 줄 선택 확장은 줄 끝까지", sel(run(expandLineSelection, stateOf("one\ntwo", 5)).state), [[4, 7]]);
}

{
  eq("대문자", transformText("uppercase", "foo Bar"), "FOO BAR");
  eq("제목 형식", transformText("titlecase", "hello wORLD it's"), "Hello World It's");
  eq("snake", transformText("snakecase", "fooBarBaz HTTPServer"), "foo_bar_baz http_server");
  eq("camel", transformText("camelcase", "foo_bar-baz qux"), "fooBarBazQux");
  eq("pascal", transformText("pascalcase", "foo_bar-baz qux"), "FooBarBazQux");
  eq("kebab", transformText("kebabcase", "fooBar_baz"), "foo-bar-baz");
  eq("선택이 없으면 커서 아래 낱말만 바꾼다", text(run(transformSelection("uppercase"), stateOf("foo bar", 5)).state), "foo BAR");
}

{
  let result = run(selectAllOccurrences, stateOf("foo bar foo foobar", 1));
  eq("커서 아래 낱말은 낱말 단위로 전부 선택", sel(result.state), [[0, 3], [8, 11]]);
  result = run(selectAllOccurrences, stateOf("Foo foo FOO", 0, 3));
  eq("선택한 글은 대소문자를 가리지 않고 전부 선택(찾기 기본값)", sel(result.state), [[0, 3], [4, 7], [8, 11]]);
  result = run(selectAllOccurrences, stateOf("   ", 1));
  check("낱말이 없으면 아무것도 안 한다", result.ok === false);

  let moved = run(moveSelectionToNextFindMatch, stateOf("ab ab ab", 1));
  eq("커서만 있으면 첫 실행은 그 낱말을 선택한다", sel(moved.state), [[0, 2]]);
  moved = run(moveSelectionToNextFindMatch, moved.state);
  eq("다음 실행은 마지막 선택을 다음 일치로 옮긴다", sel(moved.state), [[3, 5]]);
  const two = EditorState.create({ doc: "ab ab ab", selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, 5)], 1), extensions: SESSION_FIELDS });
  moved = run(moveSelectionToNextFindMatch, two);
  eq("이전 선택은 그대로 두고 마지막만 옮긴다", sel(moved.state), [[0, 2], [6, 8]]);
  const added = run(addSelectionToPreviousFindMatch, EditorState.create({ doc: "ab ab ab", selection: EditorSelection.range(6, 8), extensions: SESSION_FIELDS }));
  eq("이전 일치를 더한다", sel(added.state), [[3, 5], [6, 8]]);

  const ends = run(addCursorsToLineEnds, stateOf("abc\ndef\nghi", 1, 9));
  eq("선택한 각 줄 끝에 커서, 마지막 줄은 선택이 끝난 자리", sel(ends.state), [[3, 3], [7, 7], [9, 9]]);
  check("선택이 없으면 아무것도 안 한다", run(addCursorsToLineEnds, stateOf("abc", 1)).ok === false);
}

{
  eq("커서를 감싼 괄호 쌍을 지운다", text(run(removeBrackets, stateOf("foo(a, b)", 6)).state), "fooa, b");
  eq("커서에 붙은 괄호의 쌍을 지운다", text(run(removeBrackets, stateOf("x[1] + (2)", 4)).state), "x1 + (2)");
  eq("가장 안쪽 쌍만 지운다", text(run(removeBrackets, stateOf("f((a))", 3)).state), "f(a)");
  check("괄호 밖이면 아무것도 안 한다", run(removeBrackets, stateOf("abc", 1)).ok === false);

  let state = stateOf("0123456789", 3);
  state = run(setSelectionAnchor, state).state;
  check("앵커를 두면 앵커 위치가 기억된다", state.field(selectionAnchor) === 3);
  state = state.update({ selection: { anchor: 7 } }).state;
  state = run(selectFromAnchorToCursor, state).state;
  eq("앵커에서 커서까지 선택하고 앵커는 사라진다", [sel(state), state.field(selectionAnchor)], [[[3, 7]], null]);
  check("앵커가 없으면 Esc 는 false(다른 Esc 동작에 넘김)", run(cancelSelectionAnchor, state).ok === false);
  let anchored = run(setSelectionAnchor, stateOf("abc", 1)).state;
  anchored = anchored.update({ changes: { from: 0, insert: "xx" } }).state;
  check("편집을 따라 앵커가 움직인다", anchored.field(selectionAnchor) === 3);
  check("Esc 로 앵커를 취소", run(cancelSelectionAnchor, anchored).state.field(selectionAnchor) === null);
}

{
  const doc = "foo(barBaz, qux);";
  let state = stateOf(doc, 7);
  const steps: string[] = [];
  for (let i = 0; i < 8; i++) {
    state = run(expandSelection, state).state;
    const r = state.selection.main;
    steps.push(doc.slice(r.from, r.to));
  }
  eq("확장은 조각, 낱말, 괄호 안, 괄호 포함, 호출, 문, 문서 순서", steps.slice(0, 6), ["Baz", "barBaz", "barBaz, qux", "(barBaz, qux)", "foo(barBaz, qux)", "foo(barBaz, qux);"]);
  const back: string[] = [];
  for (let i = 0; i < 3; i++) {
    state = run(shrinkSelection, state).state;
    const r = state.selection.main;
    back.push(doc.slice(r.from, r.to));
  }
  check("축소는 확장한 순서를 되짚는다", back.length === 3 && back[2].length < back[1].length && back[1].length <= back[0].length, JSON.stringify(back));
  const typed = state.update({ changes: { from: 0, insert: " " } }).state;
  eq("문서가 바뀌면 기록을 비운다", typed.field(smartSelectStack), null);
  eq("처음 선택으로 돌아간다", sel(run(shrinkSelection, run(expandSelection, stateOf(doc, 7)).state).state), [[7, 7]]);
}

{
  const doc = Text.of(["fooBar_baz-qux HTTPServer"]);
  const forward: number[] = [];
  for (let pos = 0; forward.length < 9; ) {
    const next = wordPartRight(doc, pos);
    if (next === pos) break;
    forward.push(next);
    pos = next;
  }
  eq("오른쪽 단어 부분 이동 정류장", forward.slice(0, 6), [3, 6, 10, 11, 14, 15]);
  const backward: number[] = [];
  for (let pos = doc.length; backward.length < 9; ) {
    const next = wordPartLeft(doc, pos);
    if (next === pos) break;
    backward.push(next);
    pos = next;
  }
  eq("왼쪽 단어 부분 이동 정류장", backward.slice(0, 5), [19, 15, 14, 11, 10]);
  eq("단어 부분 선택은 앵커를 둔다", sel(run(cursorWordPart(true, true), stateOf("fooBar", 0)).state), [[0, 3]]);
  eq("단어 부분 삭제(왼쪽)", text(run(deleteWordPart(false), stateOf("fooBar_baz", 6)).state), "foo_baz");
  eq("단어 부분 삭제(오른쪽)", text(run(deleteWordPart(true), stateOf("fooBar_baz", 3)).state), "foo_baz");
  eq("공백이 둘 이상이면 공백 전체를 지운다", text(run(deleteWordPart(false), stateOf("foo    bar", 7)).state), "foobar");
}

{
  const grid = "abcdef\nabcdef\nabcdef";
  let state = stateOf(grid, 1);
  state = run(columnSelect("down"), state).state;
  state = run(columnSelect("down"), state).state;
  eq("아래로 두 번이면 세 줄에 커서", sel(state), [[1, 1], [8, 8], [15, 15]]);
  state = run(columnSelect("right"), state).state;
  state = run(columnSelect("right"), state).state;
  eq("오른쪽으로 두 칸이면 줄마다 두 글자", sel(state), [[1, 3], [8, 10], [15, 17]]);
  state = run(columnSelect("left"), state).state;
  eq("왼쪽으로 한 칸 줄인다", sel(state), [[1, 2], [8, 9], [15, 16]]);
  const short = stateOf("abcdef\nab\nabcdef", 4);
  const widened = run(columnSelect("right"), run(columnSelect("down"), run(columnSelect("down"), short).state).state).state;
  eq("짧은 줄은 열에 못 미치면 뺀다", sel(widened), [[4, 5], [14, 15]]);
  const upward = run(columnSelect("up"), stateOf(grid, 15)).state;
  eq("위로도 같다", sel(upward), [[8, 8], [15, 15]]);
}

{
  const editor: KeyContext = { inTerminal: false, inEditor: true };
  const outside: KeyContext = { inTerminal: false, inEditor: false };
  const single = (stroke: string, ctx: KeyContext) => {
    const step = stepKey(null, stroke, ctx, 0);
    return step.kind === "run" ? step.command : step.kind;
  };
  const chord = (second: string, ctx: KeyContext) => {
    const first = stepKey(null, "Meta+KeyK", ctx, 0);
    const pending: Pending | null = first.kind === "pending" ? first.pending : null;
    const step = stepKey(pending, second, ctx, 10);
    return step.kind === "run" ? step.command : step.kind;
  };
  const expectations: [string, string][] = [
    ["Ctrl+KeyJ", "editor:joinLines"],
    ["Shift+Meta+KeyL", "editor:selectHighlights"],
    ["Meta+F2", "editor:changeAll"],
    ["Ctrl+Shift+Meta+ArrowRight", "editor:smartSelectExpand"],
    ["Ctrl+Shift+Meta+ArrowLeft", "editor:smartSelectShrink"],
    ["Alt+Shift+KeyI", "editor:insertCursorAtEndOfEachLineSelected"],
    ["Alt+Shift+Meta+ArrowLeft", "editor:columnSelectLeft"],
    ["Alt+Shift+Meta+PageDown", "editor:columnSelectPageDown"],
    ["Ctrl+Alt+ArrowLeft", "editor:cursorWordPartLeft"],
    ["Ctrl+Alt+Shift+ArrowRight", "editor:cursorWordPartRightSelect"],
    ["Ctrl+Alt+Backspace", "editor:deleteWordPartLeft"],
    ["Ctrl+Alt+Delete", "editor:deleteWordPartRight"],
    ["Alt+Meta+Backspace", "editor:removeBrackets"],
  ];
  for (const [stroke, command] of expectations) check(`${stroke} 는 에디터에서 ${command}`, single(stroke, editor) === command, single(stroke, editor));
  check("에디터 밖에서는 이 키들이 앱 키가 아니다(⇧⌘L 은 Inbox)", expectations.every(([stroke]) => stroke === "Shift+Meta+KeyL" || single(stroke, outside) === "pass") && single("Shift+Meta+KeyL", outside) === "inbox");
  const chords: [string, string][] = [
    ["Meta+KeyC", "editor:addCommentLine"],
    ["Meta+KeyU", "editor:removeCommentLine"],
    ["Meta+KeyX", "editor:trimTrailingWhitespace"],
    ["Meta+KeyD", "editor:moveSelectionToNextFindMatch"],
    ["Meta+KeyB", "editor:setSelectionAnchor"],
    ["Meta+KeyK", "editor:selectFromAnchorToCursor"],
  ];
  for (const [second, command] of chords) check(`⌘K ${second} 는 에디터에서 ${command}`, chord(second, editor) === command, chord(second, editor));
  check("⌘K ⌘K 는 에디터 밖에서 chord 취소", chord("Meta+KeyK", outside) === "cancel");
  const keys = BINDINGS.map((b) => `${b.keys.join(" ")}|${b.when ?? ""}`);
  check("표에 같은 키가 두 번 들어가지 않았다", new Set(keys).size === keys.length);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
