import { BINDINGS, BROWSER_STROKES, CHORD_TIMEOUT_MS, INTERCEPT_STROKES, latinKeyOf, stepKey, strokeOf, terminalKeySequence, type KeyContext, type Pending } from "../web/keymap";
import { gridOf, moveToRow, neighbor, paneOrder, reconcileGrid, splitDown, step, swapPanes } from "../web/gridLayout";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const ctx: KeyContext = { inTerminal: false, inEditor: false };
const key = (code: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({ code, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift });

test("strokeOf: 수정키 순서가 고정이고 수정키만 눌린 입력은 null", () => {
  expect(strokeOf(key("KeyI", { shift: true, meta: true })) === "Shift+Meta+KeyI", "Shift+Meta");
  expect(strokeOf(key("KeyR", { alt: true, ctrl: true })) === "Ctrl+Alt+KeyR", "Ctrl+Alt");
  expect(strokeOf(key("MetaLeft", { meta: true })) === null, "Meta only");
  expect(strokeOf(key("ShiftRight", { shift: true })) === null, "Shift only");
  return "ok";
});

test("strokeOf: code 가 비면 key 로 되짚는다(합성 입력)", () => {
  expect(strokeOf({ key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }) === "Meta+KeyK", "k");
  expect(strokeOf({ key: "\\", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }) === "Meta+Backslash", "backslash");
  expect(strokeOf({ key: "Left", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }) === "Meta+ArrowLeft", "Left");
  return "ok";
});

test("표: 모든 키가 정규 표기(Ctrl, Alt, Shift, Meta 순서)다", () => {
  const order = ["Ctrl", "Alt", "Shift", "Meta"];
  for (const b of BINDINGS) {
    for (const stroke of b.keys) {
      const mods = stroke.split("+").slice(0, -1);
      expect(mods.every((m, i) => i === 0 || order.indexOf(mods[i - 1]) < order.indexOf(m)) && mods.every((m) => order.includes(m)), `정규 표기 아님: ${stroke}`);
    }
  }
  return "ok";
});

test("표: 같은 키가 두 번 등록되지 않았다", () => {
  const seen = new Set<string>();
  for (const b of BINDINGS) {
    const id = `${b.keys.join(" ")}|${b.when ?? ""}`;
    expect(!seen.has(id), `중복 ${id}`);
    seen.add(id);
  }
  return `${BINDINGS.length} bindings`;
});

test("chord: ⌘K 뒤 ⌘\\ 는 splitDown, ⌘\\ 단독은 split", () => {
  const first = stepKey(null, "Meta+KeyK", ctx, 0);
  expect(first.kind === "pending", "⌘K pending");
  const second = stepKey(first.kind === "pending" ? first.pending : null, "Meta+Backslash", ctx, 100);
  expect(second.kind === "run" && second.command === "splitDown", "splitDown");
  const single = stepKey(null, "Meta+Backslash", ctx, 0);
  expect(single.kind === "run" && single.command === "split", "split");
  return "ok";
});

test("chord: 수정키 입력은 호출하는 쪽이 건너뛰므로 상태가 그대로 이어진다", () => {
  const pending: Pending = { prefix: "Meta+KeyK", at: 0 };
  expect(strokeOf(key("MetaLeft", { meta: true })) === null && strokeOf(key("ShiftLeft", { shift: true })) === null, "modifier null");
  const r = stepKey(pending, "KeyW", ctx, 200);
  expect(r.kind === "run" && r.command === "closeAllChats", "⌘K W");
  return "ok";
});

test("chord: ⌘K 뒤 방향키는 ⌘ 를 쥐든 아니든 격자의 방향 이웃으로 간다", () => {
  const pending: Pending = { prefix: "Meta+KeyK", at: 0 };
  const a = stepKey(pending, "ArrowLeft", ctx, 10);
  const b = stepKey(pending, "Meta+ArrowLeft", ctx, 10);
  const c = stepKey(pending, "Meta+ArrowRight", ctx, 10);
  expect(a.kind === "run" && a.command === "focusPaneLeft", "plain left");
  expect(b.kind === "run" && b.command === "focusPaneLeft", "meta left is the pane on the left, not the previous pane");
  expect(c.kind === "run" && c.command === "focusPaneRight", "meta right");
  return "ok";
});

test("chord: 표에 없는 두 번째 키는 취소하고 삼킨다(명령 실행 없음)", () => {
  const r = stepKey({ prefix: "Meta+KeyK", at: 0 }, "KeyZ", ctx, 10);
  expect(r.kind === "cancel", "cancel");
  const esc = stepKey({ prefix: "Meta+KeyK", at: 0 }, "Escape", ctx, 10);
  expect(esc.kind === "cancel", "Escape cancels, not escape command");
  return "ok";
});

test("chord: 1.5초가 지나면 pending 이 없던 것처럼 처리한다", () => {
  const late = stepKey({ prefix: "Meta+KeyK", at: 0 }, "KeyW", ctx, CHORD_TIMEOUT_MS + 1);
  expect(late.kind === "pass", "KeyW alone passes");
  const lateSplit = stepKey({ prefix: "Meta+KeyK", at: 0 }, "Meta+Backslash", ctx, CHORD_TIMEOUT_MS + 1);
  expect(lateSplit.kind === "run" && lateSplit.command === "split", "falls back to split");
  const edge = stepKey({ prefix: "Meta+KeyK", at: 0 }, "KeyW", ctx, CHORD_TIMEOUT_MS);
  expect(edge.kind === "run", "경계(1.5초 정각)는 아직 유효");
  return "ok";
});

test("when: ⌘/ 첨부 메뉴는 입력창에 포커스가 있으면 반응하지 않고(VS Code 와 같다) 다른 곳에서는 연다", () => {
  expect(stepKey(null, "Meta+Slash", { inTerminal: false, inEditor: false, inComposer: true }, 0).kind === "pass", "입력창 안");
  const out = stepKey(null, "Meta+Slash", { inTerminal: false, inEditor: false, inComposer: false }, 0);
  expect(out.kind === "run" && out.command === "attachMenu", "입력창 밖");
  expect(stepKey(null, "Meta+Slash", ctx, 0).kind === "run", "inComposer 를 안 주면 밖으로 본다");
  return "ok";
});

test("when: ⌃C 는 터미널에서 셸로, ⌃- 는 에디터에서 코드 이동으로 남긴다", () => {
  expect(stepKey(null, "Ctrl+KeyC", { inTerminal: true, inEditor: false }, 0).kind === "pass", "terminal ^C");
  expect(stepKey(null, "Ctrl+KeyC", ctx, 0).kind === "run", "^C");
  expect(stepKey(null, "Ctrl+Minus", { inTerminal: false, inEditor: true }, 0).kind === "pass", "editor ^-");
  const out = stepKey(null, "Ctrl+Minus", ctx, 0);
  expect(out.kind === "run" && out.command === "sessionBack", "session back");
  return "ok";
});

test("수정키 없는 키는 chord 밖에서 아무것도 하지 않는다", () => {
  expect(stepKey(null, "KeyW", ctx, 0).kind === "pass", "KeyW");
  expect(stepKey(null, "ArrowLeft", ctx, 0).kind === "pass", "ArrowLeft");
  return "ok";
});

test("Electron 가로채기 집합: ⌘, ⌥ 조합만 들고 ⌃ 단독과 맨 키는 뺀다", () => {
  for (const s of ["Meta+Backslash", "Meta+KeyW", "Alt+KeyH", "Ctrl+Alt+KeyR", "Alt+Meta+ArrowLeft", "Ctrl+Meta+ArrowLeft"]) expect(INTERCEPT_STROKES.has(s), s);
  for (const s of ["Ctrl+KeyC", "Ctrl+Minus", "KeyW", "ArrowLeft", "Escape"]) expect(!INTERCEPT_STROKES.has(s), s);
  for (const s of ["Meta+KeyK", "Meta+ArrowLeft", "Meta+ArrowRight", "Meta+ArrowUp", "Meta+ArrowDown"]) expect(!INTERCEPT_STROKES.has(s), `가로채지 않음: ${s}`);
  return "ok";
});

test("Browser 탭 전용 키: Browser 탭이 활성일 때만 듣고, 가로채기 집합에는 없고 guest 용 집합에 있다", () => {
  const inBrowser: KeyContext = { ...ctx, inBrowser: true };
  const expected: Record<string, string> = { "Meta+KeyT": "openBrowser", "Meta+Equal": "browserZoomIn", "Meta+Minus": "browserZoomOut", "Meta+Numpad0": "browserZoomReset", "Meta+KeyF": "browserFind", "Meta+KeyY": "browserHistory", "Meta+KeyD": "browserFavorite", "Shift+Meta+KeyC": "addElement", "Alt+Meta+KeyC": "commentElements" };
  for (const [stroke, command] of Object.entries(expected)) {
    const on = stepKey(null, stroke, inBrowser, 0);
    expect(on.kind === "run" && on.command === command, `${stroke} 은 Browser 탭에서 ${command}`);
    const other = stepKey(null, stroke, ctx, 0);
    if (stroke === "Meta+KeyT") expect(other.kind === "run" && other.command === "symbols" && INTERCEPT_STROKES.has(stroke) && BROWSER_STROKES.has(stroke), "⌘T 는 다른 탭에서 워크스페이스 심볼");
    else expect(other.kind === "pass", `${stroke} 은 다른 탭에서 그대로 통과`);
    const windowZoom = ["Meta+Equal", "Meta+Minus", "Meta+Numpad0"].includes(stroke);
    if (stroke !== "Meta+KeyT") expect(INTERCEPT_STROKES.has(stroke) === windowZoom && BROWSER_STROKES.has(stroke), `${stroke} 집합`);
  }
  expect(stepKey(null, "Meta+KeyF", { ...ctx, inEditor: true }, 0).kind === "pass", "editor ⌘F");
  const search = stepKey(null, "Shift+Meta+KeyF", ctx, 0);
  expect(search.kind === "run" && search.command === "findInFiles" && INTERCEPT_STROKES.has("Shift+Meta+KeyF"), "⇧⌘F 는 어디서나 Search 뷰(Find in Files)");
  const inEditor = stepKey(null, "Shift+Meta+KeyF", { ...ctx, inEditor: true, inEditorArea: true }, 0);
  expect(inEditor.kind === "run" && inEditor.command === "findInFiles", "에디터에 포커스가 있어도 같은 명령(선택 글은 명령이 읽는다)");
  expect(!BINDINGS.some((b) => b.command === "openSearch"), "에디터 탭 Search(Open New Search Editor)는 키가 없다");
  return "ok";
});

test("격자: 오른쪽 분할, 아래 분할, 이웃 찾기", () => {
  let g = reconcileGrid(gridOf([]), ["a"], null);
  g = reconcileGrid(g, ["a", "b"], "a");
  expect(g.rows.length === 1 && g.rows[0].ids.join() === "a,b", "right split");
  g = splitDown(g, "a", "c");
  expect(g.rows.map((r) => r.ids.join()).join("|") === "a,b|c", "down split row");
  expect(neighbor(g, "a", "down") === "c" && neighbor(g, "b", "down") === "c", "down neighbors");
  expect(neighbor(g, "c", "up") === "a" && neighbor(g, "a", "right") === "b" && neighbor(g, "b", "right") === null, "up/right");
  expect(step(g, "b", 1) === "c" && step(g, "c", 1) === null && step(g, "a", -1) === null, "step order");
  return "ok";
});

test("격자: 칸이 닫히면 빈 행이 사라지고 행 비율도 같이 빠진다", () => {
  let g = reconcileGrid(gridOf([]), ["a", "b"], null);
  g = splitDown(g, "a", "c");
  g = { ...g, rowWeights: [300, 100] };
  const closed = reconcileGrid(g, ["b", "c"], null);
  expect(closed.rows.map((r) => r.ids.join()).join("|") === "b|c", "rows after closing a");
  expect(closed.rowWeights?.join() === "300,100", "rowWeights kept for surviving rows");
  const closedRow = reconcileGrid(g, ["a", "b"], null);
  expect(closedRow.rows.length === 1 && closedRow.rowWeights?.join() === "300", "removed row weight dropped");
  return "ok";
});

test("격자: 새 칸은 anchor 오른쪽에 들어오고 폭 정해진 행에서는 평균 폭을 받는다", () => {
  let g = reconcileGrid(gridOf([]), ["a", "b"], null);
  g = { ...g, colWeights: { a: 400, b: 200 } };
  g = reconcileGrid(g, ["a", "b", "n"], "a");
  expect(g.rows[0].ids.join() === "a,n,b", "after anchor");
  expect(g.colWeights.n === 300, "mean width");
  return "ok";
});

test("격자: 같은 칸 집합이면 같은 객체를 돌려준다", () => {
  const g = reconcileGrid(gridOf([]), ["a", "b"], null);
  expect(reconcileGrid(g, ["b", "a"], null) === g, "same ref");
  return "ok";
});

test("격자: 자리를 바꾸면 폭 비율이 자리에 남는다", () => {
  let g = reconcileGrid(gridOf([]), ["a", "b"], null);
  g = { ...g, colWeights: { a: 500, b: 100 } };
  const s = swapPanes(g, "a", "b");
  expect(paneOrder(s).join() === "b,a", "order");
  expect(s.colWeights.b === 500 && s.colWeights.a === 100, "weights follow position");
  return "ok";
});

test("B7: ⌃⌘←→ 는 대화 칸에선 채팅 이동, 에디터에 포커스가 있으면 Move Editor into Group(↑↓ 는 키 없음)", () => {
  const run = (code: string, editor: boolean) => {
    const stroke = strokeOf(key(code, { ctrl: true, meta: true }))!;
    const result = stepKey(null, stroke, { ...ctx, inEditor: editor, inEditorArea: editor }, 0);
    return result.kind === "run" ? result.command : result.kind;
  };
  expect(run("ArrowLeft", false) === "movePanePrev" && run("ArrowRight", false) === "movePaneNext", "chat left right");
  expect(run("ArrowUp", false) === "pass" && run("ArrowDown", false) === "pass", "VS Code 에이전트 창에 ⌃⌘↑↓ 는 없다");
  expect(run("ArrowLeft", true) === "moveEditorToPreviousGroup" && run("ArrowRight", true) === "moveEditorToNextGroup", "editor previous next");
  expect(run("ArrowUp", true) === "pass" && run("ArrowDown", true) === "pass", "VS Code 에디터에 ⌃⌘↑↓ 키는 없다");
  return "ok";
});

test("B7: ⌘S, ⇧⌥F, ⌘K ⌘F, ⌘\\ 와 ⌘K ⌘\\ 는 에디터에서 에디터 명령, 밖에서는 대화 칸 명령", () => {
  const stroke = (code: string, mods: Parameters<typeof key>[1]) => strokeOf(key(code, mods))!;
  const single = (code: string, mods: Parameters<typeof key>[1], editor: boolean) => {
    const r = stepKey(null, stroke(code, mods), { ...ctx, inEditor: editor, inEditorArea: editor }, 0);
    return r.kind === "run" ? r.command : r.kind;
  };
  const chord = (second: string, editor: boolean) => {
    const first = stepKey(null, stroke("KeyK", { meta: true }), { ...ctx, inEditor: editor, inEditorArea: editor }, 0);
    const r = stepKey(first.pending, stroke(second, { meta: true }), { ...ctx, inEditor: editor, inEditorArea: editor }, 10);
    return r.kind === "run" ? r.command : r.kind;
  };
  expect(single("KeyS", { meta: true }, false) === "save" && single("KeyS", { meta: true }, true) === "save", "save anywhere");
  expect(single("KeyF", { alt: true, shift: true }, true) === "formatDocument" && single("KeyF", { alt: true, shift: true }, false) === "pass", "format document only in editor");
  expect(chord("KeyF", true) === "formatSelection", "format selection");
  expect(single("Backslash", { meta: true }, true) === "splitEditorRight" && single("Backslash", { meta: true }, false) === "split", "split right");
  expect(chord("Backslash", true) === "splitEditorDown" && chord("Backslash", false) === "splitDown", "split down");
  expect(chord("ArrowLeft", true) === "focusLeftEditorGroup" && chord("ArrowLeft", false) === "focusPaneLeft", "focus group");
  return "ok";
});

test("B7: 새 키가 Electron 이 가로채는 집합에 든다(⌘S, ⌥⇧F, ⌃⌘ 방향키)", () => {
  for (const stroke of ["Meta+KeyS", "Ctrl+Meta+ArrowLeft", "Ctrl+Meta+ArrowRight"]) expect(INTERCEPT_STROKES.has(stroke), `intercept ${stroke}`);
  expect(!INTERCEPT_STROKES.has("Alt+Shift+KeyF"), "⌥⇧F 는 가로채지 않음");
  return "ok";
});

test("B7: 채팅을 이웃 칸으로 옮기는 순서는 끝에서 반대쪽으로 이어지고, 칸이 하나면 아무것도 안 한다", () => {
  const three = gridOf(["a", "b", "c"]);
  expect(step(three, "c", 1, true) === "a" && step(three, "a", -1, true) === "c" && step(three, "b", 1, true) === "c", "wrap");
  expect(step(three, "c", 1) === null, "no wrap by default");
  expect(step(gridOf(["a"]), "a", 1, true) === null, "one pane");
  return "ok";
});

test("B7: 채팅을 위, 아래 행으로 옮기면 행 끝에 붙고 없으면 새 행, 행이 비면 닫힌다", () => {
  const two = splitDown(gridOf(["a", "b"]), "a", "c");
  expect(two.rows.map((r) => r.ids.join()).join("|") === "a,b|c", "setup");
  const down = moveToRow(two, "a", 1)!;
  expect(down.rows.map((r) => r.ids.join()).join("|") === "b|c,a", "a into the row below");
  const up = moveToRow(two, "c", -1)!;
  expect(up.rows.map((r) => r.ids.join()).join("|") === "a,b,c", "c up, its row closes");
  expect(moveToRow(two, "c", 1) === null && moveToRow(two, "a", -1)!.rows.map((r) => r.ids.join()).join("|") === "a|b|c", "lone row cannot go further, shared row opens a new row above");
  return "ok";
});

const inEditorCtx: KeyContext = { inTerminal: false, inEditor: true, inEditorArea: true };
const inComposerCtx: KeyContext = { inTerminal: false, inEditor: false, inComposer: true };
const inTerminalCtx: KeyContext = { inTerminal: true, inEditor: false };
const verdict = (stroke: string, c: KeyContext) => {
  const out = stepKey(null, stroke, c, 0);
  return out.kind === "run" ? out.command : out.kind;
};

test("keys: 에디터에서는 VS Code 에디터 키가 앱 키보다 먼저다(⌥⌘↑↓ 커서 추가, ⇧⌘K 줄 삭제, ⇧⌘L 같은 글 선택, ⌘/ 주석, ⌥⌘F 바꾸기)", () => {
  for (const stroke of ["Alt+Meta+ArrowUp", "Alt+Meta+ArrowDown", "Shift+Meta+KeyK", "Meta+Slash", "Alt+Meta+KeyF"]) {
    expect(verdict(stroke, inEditorCtx) === "pass", `에디터에서 ${stroke} 는 앱이 건드리지 않는다: ${verdict(stroke, inEditorCtx)}`);
    expect(verdict(stroke, ctx) !== "pass", `에디터 밖에서 ${stroke} 는 앱 키: ${verdict(stroke, ctx)}`);
  }
  expect(verdict("Shift+Meta+KeyL", inEditorCtx) === "editor:selectHighlights" && verdict("Shift+Meta+KeyL", ctx) === "inbox", "⇧⌘L");
  expect(verdict("Alt+Meta+ArrowUp", ctx) === "promptPrev" && verdict("Alt+Meta+ArrowDown", ctx) === "promptNext", "말풍선 이동");
  expect(verdict("Shift+Meta+KeyK", ctx) === "board" && verdict("Shift+Meta+KeyL", ctx) === "inbox" && verdict("Alt+Meta+KeyF", ctx) === "feedback", "Board, Inbox, Feedback");
  return "ok";
});

test("keys: ⌘/ 첨부 메뉴는 에디터와 입력창에서 열리지 않는다", () => {
  expect(verdict("Meta+Slash", inEditorCtx) === "pass" && verdict("Meta+Slash", inComposerCtx) === "pass", "에디터, 입력창");
  expect(verdict("Meta+Slash", ctx) === "attachMenu" && verdict("Meta+Slash", inTerminalCtx) === "attachMenu", "그 밖");
  return "ok";
});

test("keys: 에디터 고유 키(⌘←→↑↓, ⇧⌘←→↑↓, ⌥←→, ⌘D, ⌘Enter, ⌘A, ⌘Z, Home, End, PageUp, PageDown, Tab)는 어느 맥락에서도 앱 키가 아니다", () => {
  const editorKeys = ["Meta+ArrowLeft", "Meta+ArrowRight", "Meta+ArrowUp", "Meta+ArrowDown", "Shift+Meta+ArrowLeft", "Shift+Meta+ArrowRight", "Shift+Meta+ArrowUp", "Shift+Meta+ArrowDown", "Alt+ArrowLeft", "Alt+ArrowRight", "Alt+Shift+ArrowLeft", "Alt+Shift+ArrowRight", "Alt+ArrowUp", "Alt+ArrowDown", "Alt+Shift+ArrowUp", "Alt+Shift+ArrowDown", "Meta+KeyD", "Meta+Enter", "Shift+Meta+Enter", "Meta+KeyA", "Meta+KeyZ", "Shift+Meta+KeyZ", "Meta+KeyX", "Meta+KeyG", "Home", "End", "PageUp", "PageDown", "Tab", "Shift+Tab", "F12", "Shift+F12"];
  for (const stroke of editorKeys) for (const [name, c] of [["에디터", inEditorCtx], ["입력창", inComposerCtx], ["터미널", inTerminalCtx], ["그 밖", ctx]] as const) expect(verdict(stroke, c) === "pass", `${name} 에서 ${stroke}: ${verdict(stroke, c)}`);
  return "ok";
});

test("keys: ⌘[ ⌘] 는 에디터에서는 내어쓰기, 들여쓰기로 통과하고, 그 밖에서는 세션 뒤로, 앞으로", () => {
  expect(verdict("Meta+BracketLeft", inEditorCtx) === "pass" && verdict("Meta+BracketRight", inEditorCtx) === "pass", "에디터에서는 통과");
  for (const c of [inComposerCtx, ctx]) expect(verdict("Meta+BracketLeft", c) === "sessionBack" && verdict("Meta+BracketRight", c) === "sessionForward", "에디터 밖에서는 세션 이동");
  return "ok";
});

test("keys: 에디터 저장, 포맷, 분할 키는 에디터에서 그대로 앱 명령이다", () => {
  expect(verdict("Meta+KeyS", inEditorCtx) === "save" && verdict("Alt+Shift+KeyF", inEditorCtx) === "formatDocument" && verdict("Meta+Backslash", inEditorCtx) === "splitEditorRight", "save, format, split");
  expect(verdict("Alt+Shift+KeyF", ctx) === "pass", "에디터 밖의 ⌥⇧F 는 통과");
  return "ok";
});

test("keys: chord 의 두 번째 키 ⌘←→↑↓ 는 chord 가 진행 중일 때만 대화 칸을 옮기고, 평소에는 통과한다", () => {
  const pending: Pending = { prefix: "Meta+KeyK", at: 0 };
  expect(stepKey(null, "Meta+ArrowLeft", inEditorCtx, 0).kind === "pass", "chord 없이는 통과");
  const after = stepKey(pending, "Meta+ArrowLeft", inEditorCtx, 10);
  expect(after.kind === "run" && after.command === "focusLeftEditorGroup", "에디터에서 ⌘K ⌘←");
  const outside = stepKey(pending, "Meta+ArrowLeft", ctx, 10);
  expect(outside.kind === "run" && outside.command === "focusPaneLeft", "에디터 밖에서 ⌘K ⌘←");
  return "ok";
});

test("keys: 창 확대 키(⌘=, ⇧⌘=, ⌘NumPad+, ⌘-, ⇧⌘-, ⌘NumPad-, ⌘NumPad0, ⌘0)는 앱 창에서만 창 확대, Browser 탭에 포커스가 있으면 페이지 확대", () => {
  const electron: KeyContext = { ...ctx, inElectron: true };
  const browser: KeyContext = { ...electron, inBrowser: true };
  const zoom: Record<string, [string, string]> = {
    "Meta+Equal": ["zoomIn", "browserZoomIn"], "Shift+Meta+Equal": ["zoomIn", "zoomIn"], "Meta+NumpadAdd": ["zoomIn", "zoomIn"],
    "Meta+Minus": ["zoomOut", "browserZoomOut"], "Shift+Meta+Minus": ["zoomOut", "zoomOut"], "Meta+NumpadSubtract": ["zoomOut", "zoomOut"],
    "Meta+Numpad0": ["zoomReset", "browserZoomReset"], "Meta+Digit0": ["zoomReset", "zoomReset"],
  };
  for (const [stroke, [window, page]] of Object.entries(zoom)) {
    expect(verdict(stroke, electron) === window, `${stroke} 창: ${verdict(stroke, electron)}`);
    expect(verdict(stroke, { ...electron, inEditor: true }) === window, `${stroke} 에디터에서도 창 확대`);
    expect(verdict(stroke, { ...electron, inTerminal: true }) === window, `${stroke} 터미널에서도 창 확대`);
    expect(verdict(stroke, browser) === page, `${stroke} Browser 탭: ${verdict(stroke, browser)}`);
    expect(verdict(stroke, ctx) !== window, `${stroke} 웹 접속에서는 브라우저 자기 확대가 먼저(앱이 건드리지 않는다)`);
    expect(INTERCEPT_STROKES.has(stroke) && BROWSER_STROKES.has(stroke) === (page !== window), `${stroke} 집합`);
  }
  return "ok";
});

test("keys: 가로채기 집합의 모든 키는 맥락과 상관없이 늘 맞는 줄이 있다(메인이 맥락을 모르고 삼켜도 되는 키만)", () => {
  for (const stroke of INTERCEPT_STROKES) {
    const always = BINDINGS.some((b) => b.keys.length === 1 && b.keys[0] === stroke && (b.when === undefined || b.when === "electron"));
    expect(always, `${stroke} 에 무조건 맞는 줄이 없다`);
  }
  return "ok";
});

test("keys: 터미널 줄 편집 키는 VS Code 맥 기본에 사용자의 keybindings.json 두 줄을 더한 바이트열을 셸로 보낸다", () => {
  const k = (key: string, mods: { meta?: boolean; alt?: boolean; shift?: boolean; ctrl?: boolean } = {}) => terminalKeySequence({ key, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl }, false);
  expect(k("ArrowLeft", { meta: true }) === "\x01" && k("ArrowRight", { meta: true }) === "\x05", "⌘←→ 줄 처음, 끝");
  expect(k("ArrowLeft", { alt: true }) === "\x1bb" && k("ArrowRight", { alt: true }) === "\x1bf", "⌥←→ 낱말");
  expect(k("Backspace", { meta: true }) === "\x15" && k("Backspace", { alt: true }) === "\x17", "⌘⌫ 줄, ⌥⌫ 낱말 지우기");
  expect(k("Enter", { shift: true }) === "\x1b\r", "⇧Enter 줄바꿈(사용자)");
  expect(k("c", { meta: true }) === "\x19", "선택 없는 ⌘C 는 ^Y(사용자)");
  expect(terminalKeySequence({ key: "c", metaKey: true, altKey: false, shiftKey: false, ctrlKey: false }, true) === null, "선택이 있으면 복사");
  expect(k("c", { ctrl: true }) === null && k("ArrowLeft") === null && k("a") === null, "그 밖은 xterm 이 처리");
  expect(terminalKeySequence({ key: "ㅊ", code: "KeyC", metaKey: true, altKey: false, shiftKey: false, ctrlKey: false }, false) === "\x19", "한글 입력의 선택 없는 ⌘C");
  expect(latinKeyOf({ key: "ㅊ", code: "KeyC" }) === "c" && latinKeyOf({ key: "j", code: "KeyC" }) === "j" && latinKeyOf({ key: "Enter", code: "Enter" }) === "Enter", "latinKeyOf: 자모는 code, 로마자는 key(Dvorak), 글자 키가 아니면 key");
  return "ok";
});

test("F8, ⇧F8 와 ⌥F8, ⇧⌥F8: 에디터에서만 다음, 이전 문제", () => {
  const editor: KeyContext = { inTerminal: false, inEditor: true, inEditorArea: true };
  const run = (stroke: string, c: KeyContext) => {
    const step = stepKey(null, stroke, c, 0);
    return step.kind === "run" ? step.command : step.kind;
  };
  expect(run("F8", editor) === "nextProblem" && run("Shift+F8", editor) === "prevProblem", "F8 계열");
  expect(run("Alt+F8", editor) === "nextProblem" && run("Alt+Shift+F8", editor) === "prevProblem", "⌥F8 계열");
  expect(run("F8", ctx) === "pass" && run("Shift+F8", ctx) === "pass", "에디터 밖에서는 건드리지 않음");
  expect(!INTERCEPT_STROKES.has("F8") && !INTERCEPT_STROKES.has("Shift+F8"), "메인이 가로채지 않음");
  return "ok";
});

test("C: 터미널의 ⌘K 는 지우기로 바로 실행되고 chord 를 기다리지 않는다", () => {
  const terminal: KeyContext = { inTerminal: true, inEditor: false };
  const step = stepKey(null, "Meta+KeyK", terminal, 0);
  expect(step.kind === "run" && step.command === "terminalClear" && step.pending === null, "terminalClear 실행, pending 없음");
  const next = stepKey(step.pending, "KeyW", terminal, 100);
  expect(next.kind === "pass", "다음 글자 키는 삼켜지지 않는다");
  const outside = stepKey(null, "Meta+KeyK", ctx, 0);
  expect(outside.kind === "pending" && outside.opens === "search", "터미널 밖은 이전처럼 검색 + chord 대기");
  const editor = stepKey(null, "Meta+KeyK", { inTerminal: false, inEditor: true }, 0);
  expect(editor.kind === "pending" && !editor.opens, "에디터는 chord 대기만");
  return "ok";
});

test("C: chord 의 두 번째 키가 표에 없으면 cancel 이다(호출하는 쪽이 알리고 키는 그대로 넘긴다)", () => {
  const editor: KeyContext = { inTerminal: false, inEditor: true, inEditorArea: true };
  const first = stepKey(null, "Meta+KeyK", editor, 0);
  const second = stepKey(first.kind === "pending" ? first.pending : null, "KeyX", editor, 100);
  expect(second.kind === "cancel" && second.pending === null, "cancel");
  return "ok";
});

const inAreaCtx: KeyContext = { inTerminal: false, inEditor: false, inEditorArea: true };
const chordVerdict = (second: string, c: KeyContext) => {
  const first = stepKey(null, "Meta+KeyK", c, 0);
  const r = stepKey(first.pending, second, c, 10);
  return r.kind === "run" ? r.command : r.kind;
};

test("groups: ⌘1~8 은 에디터 영역에서 그룹 포커스, 밖에서는 세션 칸 포커스이고 ⌘9 는 늘 마지막 세션", () => {
  expect(verdict("Meta+Digit1", inAreaCtx) === "focusEditorGroup:0" && verdict("Meta+Digit8", inAreaCtx) === "focusEditorGroup:7", "영역 안");
  expect(verdict("Meta+Digit1", ctx) === "focusPaneIndex:0" && verdict("Meta+Digit8", ctx) === "focusPaneIndex:7", "영역 밖");
  expect(verdict("Meta+Digit9", inAreaCtx) === "focusPaneIndex:last", "⌘9 는 에디터 그룹 키가 아니다");
  expect(verdict("Meta+Digit2", inEditorCtx) === "focusEditorGroup:1", "에디터 그룹 안의 .cm-editor 는 영역 안이다");  return "ok";
});

test("groups: ⌥⌘←→ 는 포커스가 어디 있든 이전, 다음 에디터 탭", () => {
  expect(verdict("Alt+Meta+ArrowLeft", inAreaCtx) === "previousEditor" && verdict("Alt+Meta+ArrowRight", inAreaCtx) === "nextEditor", "영역 안");
  expect(verdict("Alt+Meta+ArrowLeft", ctx) === "previousEditor" && verdict("Alt+Meta+ArrowRight", ctx) === "nextEditor", "영역 밖");
  expect(verdict("Alt+Meta+ArrowLeft", inComposerCtx) === "previousEditor", "입력창");
  return "ok";
});

test("groups: ⌘K 뒤 방향 chord 는 영역 안에서 그룹 포커스, 그룹 옮기기, 그룹 안 탭 이동", () => {
  expect(chordVerdict("Meta+ArrowLeft", inAreaCtx) === "focusLeftEditorGroup" && chordVerdict("Meta+ArrowRight", inAreaCtx) === "focusRightEditorGroup", "좌우 포커스");
  expect(chordVerdict("Meta+ArrowUp", inAreaCtx) === "focusAboveEditorGroup" && chordVerdict("Meta+ArrowDown", inAreaCtx) === "focusBelowEditorGroup", "상하 포커스");
  expect(chordVerdict("ArrowLeft", inAreaCtx) === "moveEditorGroupLeft" && chordVerdict("ArrowDown", inAreaCtx) === "moveEditorGroupDown", "그룹 옮기기");
  expect(chordVerdict("Alt+Meta+ArrowRight", inAreaCtx) === "nextEditorInGroup" && chordVerdict("Shift+Meta+ArrowLeft", inAreaCtx) === "moveEditorLeftInGroup", "그룹 안 탭");
  expect(chordVerdict("ArrowLeft", ctx) === "focusPaneLeft", "영역 밖의 ⌘K ← 는 세션 칸 포커스");
  return "ok";
});

test("groups: 닫기, 고정, 최대화 chord 와 탭 이동 키", () => {
  expect(chordVerdict("KeyW", inAreaCtx) === "closeEditorsInGroup" && chordVerdict("KeyW", ctx) === "closeAllChats", "⌘K W");
  expect(chordVerdict("Meta+KeyW", inAreaCtx) === "closeAllEditors" && chordVerdict("Meta+KeyW", ctx) === "closeAllSessions", "⌘K ⌘W");
  expect(chordVerdict("KeyU", inAreaCtx) === "closeUnmodifiedEditors" && chordVerdict("Shift+Meta+KeyW", inAreaCtx) === "closeAllGroups", "⌘K U, ⌘K ⇧⌘W");
  expect(chordVerdict("Enter", inAreaCtx) === "keepEditor" && chordVerdict("Shift+Enter", inAreaCtx) === "pinEditor", "Keep Open, Pin");
  expect(chordVerdict("Meta+KeyM", inAreaCtx) === "toggleMaximizeEditorGroup", "⌘K ⌘M");
  expect(verdict("Alt+Meta+KeyT", inAreaCtx) === "closeOtherEditors" && verdict("Alt+Meta+Digit0", inAreaCtx) === "flipEditorGroupLayout", "⌥⌘T, ⌥⌘0");
  expect(verdict("Ctrl+Digit1", inAreaCtx) === "openEditorAtIndex:0" && verdict("Ctrl+Digit9", inAreaCtx) === "openEditorAtIndex:8" && verdict("Ctrl+Digit0", inAreaCtx) === "lastEditorInGroup", "⌃1~9, ⌃0");
  expect(verdict("Ctrl+Tab", inAreaCtx) === "cycleRecentEditor" && verdict("Ctrl+Shift+Tab", inAreaCtx) === "cycleRecentEditorBack", "⌃Tab");
  expect(verdict("Ctrl+Meta+Digit1", inAreaCtx) === "moveEditorToFirstGroup" && verdict("Ctrl+Meta+Digit9", inAreaCtx) === "moveEditorToLastGroup", "⌃⌘1, ⌃⌘9");
  expect(verdict("Shift+Meta+KeyT", inAreaCtx) === "reopenClosedEditor" && verdict("Shift+Meta+KeyT", ctx) === "reopenClosed", "⇧⌘T");
  return "ok";
});

test("groups: ⌘\\ 와 ⌘K ⌘\\ 는 에디터 영역에서 에디터 분할(Browser 탭 등 .cm-editor 밖 포함)", () => {
  expect(verdict("Meta+Backslash", inAreaCtx) === "splitEditorRight" && chordVerdict("Meta+Backslash", inAreaCtx) === "splitEditorDown", "영역 안");
  expect(verdict("Meta+Backslash", ctx) === "split" && chordVerdict("Meta+Backslash", ctx) === "splitDown", "영역 밖");
  return "ok";
});

test("groups: 정의를 옆 그룹에 여는 ⌘K F12 는 에디터(.cm-editor)에서만", () => {
  expect(chordVerdict("F12", inEditorCtx) === "revealDefinitionAside" && chordVerdict("F12", inAreaCtx) === "cancel", "에디터 안에서만");
  return "ok";
});


const focusCtx: KeyContext = { inTerminal: false, inEditor: false, inFocusLayout: true };
const focusVerdict = (stroke: string, c: KeyContext) => {
  const step = stepKey(null, stroke, c, 0);
  return step.kind === "run" ? step.command : step.kind;
};

test("focus: ⌘B 는 Editor 중심에서 왼쪽 사이드바, Chat 중심에서는 앱 사이드바", () => {
  expect(focusVerdict("Meta+KeyB", focusCtx) === "toggleFocusSide", `focus ${focusVerdict("Meta+KeyB", focusCtx)}`);
  expect(focusVerdict("Meta+KeyB", ctx) === "toggleSidebar", `chat ${focusVerdict("Meta+KeyB", ctx)}`);
  expect(focusVerdict("Meta+KeyB", { ...focusCtx, inEditor: true }) === "toggleFocusSide", "editor focus");
  return "ok";
});

test("focus: ⌥⌘B 는 Editor 중심에서 오른쪽 대화 패널, Chat 중심에서는 오른쪽 패널", () => {
  expect(focusVerdict("Alt+Meta+KeyB", focusCtx) === "toggleFocusChat", `focus ${focusVerdict("Alt+Meta+KeyB", focusCtx)}`);
  expect(focusVerdict("Alt+Meta+KeyB", ctx) === "toggleRight", `chat ${focusVerdict("Alt+Meta+KeyB", ctx)}`);
  return "ok";
});

test("focus: ⇧⌘G 는 Editor 중심의 에디터 밖에서만 Source Control, ⌃⇧G 는 두 배치 모두", () => {
  expect(focusVerdict("Shift+Meta+KeyG", focusCtx) === "sourceControl", "focus outside editor");
  expect(focusVerdict("Shift+Meta+KeyG", { ...focusCtx, inEditor: true }) === "pass", "에디터의 이전 찾기는 그대로");
  expect(focusVerdict("Shift+Meta+KeyG", ctx) === "pass", "Chat 중심에는 없다");
  expect(focusVerdict("Ctrl+Shift+KeyG", focusCtx) === "sourceControl" && focusVerdict("Ctrl+Shift+KeyG", ctx) === "sourceControl", "⌃⇧G");
  return "ok";
});

test("focus: ⇧⌘E 와 ⇧⌘F 는 배치와 상관없이 같은 명령(사이드바 위치는 명령이 아니라 배치가 정한다)", () => {
  for (const c of [ctx, focusCtx]) {
    expect(focusVerdict("Shift+Meta+KeyE", c) === "showFiles", "explorer");
    expect(focusVerdict("Shift+Meta+KeyF", c) === "findInFiles", "search");
  }
  return "ok";
});

test("focus: 새 when 키는 Electron 메인이 가로채는 집합을 늘리지 않는다(앱 재설치가 필요 없다)", () => {
  expect(INTERCEPT_STROKES.has("Meta+KeyB") && INTERCEPT_STROKES.has("Alt+Meta+KeyB"), "기존 키는 이미 가로챈다");
  expect(!INTERCEPT_STROKES.has("Shift+Meta+KeyG"), "⇧⌘G 는 가로채지 않는다");
  const focusOnly = BINDINGS.filter((b) => b.when === "focusLayout" || b.when === "focusNotEditor");
  expect(focusOnly.length === 3 && focusOnly.every((b) => b.keys.length === 1), `focus 전용 ${focusOnly.length}개`);
  return "3개";
});


let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
