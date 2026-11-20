// 단축키 프리셋(web/keymap.ts 의 bindingsFor, WEBSTORM_BINDINGS)과 프리셋별 가로채기 집합을 DOM 없이 확인한다.
// 실행: npm test
import { readdirSync, readFileSync } from "node:fs";
import { KEYMAP_PRESETS } from "../shared/protocol";
import {
  BINDINGS,
  BROWSER_STROKES,
  INTERCEPT_STROKES,
  KEYUP_AWARE_STROKES,
  WEBSTORM_BINDINGS,
  WEBSTORM_DROPS,
  acceleratorOf,
  activeBindings,
  bindingsFor,
  browserStrokes,
  editorTakenStrokes,
  interceptStrokes,
  keyupAwareStrokes,
  menuAccelerator,
  chordFollowersOf,
  strokeOfAccelerator,
  setKeymapPreset,
  setKeymapOverrides,
  stepKey,
  assignKeys,
  findConflicts,
  isRecordableStroke,
  keysOf,
  resetKeys,
  type KeyContext,
} from "../web/keymap";
import { sanitizeKeymapOverrides } from "../shared/keymapOverrides";
import { titleOf } from "../web/commands";
import { FOLD_COMMANDS } from "../web/editorFoldRegions";
import { shortcutRows, strokeLabel } from "../web/shortcutList";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const same = (actual: unknown, wanted: unknown, label: string) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(wanted);
  if (a !== b) throw new Error(`${label}: ${a} != ${b}`);
};

const webstorm = bindingsFor("webstorm");
const inEditor: KeyContext = { inTerminal: false, inEditor: true, inEditorArea: true, inElectron: true };
const outside: KeyContext = { inTerminal: false, inEditor: false, inElectron: true };
const verdict = (stroke: string, ctx: KeyContext, bindings = webstorm) => {
  const step = stepKey(null, stroke, ctx, 0, bindings);
  return step.kind === "run" ? step.command : step.kind;
};
const idOf = (b: { keys: readonly string[]; when?: string }) => `${b.keys.join(" ")}|${b.when ?? ""}`;

test("프리셋 목록: vscode 와 webstorm", () => {
  same([...KEYMAP_PRESETS], ["vscode", "webstorm"], "presets");
  return "ok";
});

test("vscode 프리셋은 BINDINGS 그대로이고, 활성 프리셋 기본값도 vscode", () => {
  expect(bindingsFor("vscode") === BINDINGS, "같은 배열");
  expect(activeBindings() === BINDINGS, "기본 활성 표");
  return "ok";
});

test("webstorm 표: 같은 키+조건이 두 번 들어가지 않았다", () => {
  const seen = new Set<string>();
  for (const b of webstorm) {
    const id = idOf(b);
    expect(!seen.has(id), `중복 ${id}`);
    seen.add(id);
  }
  return `${webstorm.length} bindings`;
});

test("webstorm 표: 모든 키가 정규 표기(Ctrl, Alt, Shift, Meta 순서)다", () => {
  const order = ["Ctrl", "Alt", "Shift", "Meta"];
  for (const b of WEBSTORM_BINDINGS) {
    for (const stroke of b.keys) {
      const mods = stroke.split("+").slice(0, -1);
      expect(mods.every((m, i) => order.includes(m) && (i === 0 || order.indexOf(mods[i - 1]) < order.indexOf(m))), `정규 표기 아님: ${stroke}`);
    }
  }
  return "ok";
});

// 등록된 에디터 명령 id: registerEditorCommands 를 부르는 모듈의 `id: "..."` 와 접기 명령 표. 모듈을 불러오면 CSS 와 DOM 이 딸려와서 소스에서 읽는다.
function registeredEditorIds(): Set<string> {
  const ids = new Set<string>(FOLD_COMMANDS.map((c) => c.id));
  for (const name of readdirSync("web").filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(`web/${name}`, "utf8");
    if (!source.includes("registerEditorCommands(")) continue;
    for (const match of source.matchAll(/\bid: "([A-Za-z0-9]+)"/g)) ids.add(match[1]);
  }
  return ids;
}

test("webstorm 표: 모든 명령이 이름이 있는 앱 명령이거나 등록된 에디터 명령이다", () => {
  const registered = registeredEditorIds();
  for (const b of WEBSTORM_BINDINGS) {
    if (b.command.startsWith("editor:")) expect(registered.has(b.command.slice(7)), `등록 안 된 에디터 명령 ${b.command}`);
    else expect(!!titleOf(b.command), `이름 없는 명령 ${b.command}`);
  }
  return `${registered.size} 에디터 명령`;
});

test("webstorm 표: 프리셋이 추가한 에디터 명령에는 이름이 있다", () => {
  const source = readFileSync("web/editorPresetCommands.ts", "utf8");
  const ids = [...source.matchAll(/\{ id: "([A-Za-z0-9]+)", title: "([^"]+)"/g)];
  expect(ids.length === 19, `등록 ${ids.length}개`);
  return `${ids.length}개`;
});

test("webstorm 표: 뺀 VS Code 줄은 사라지고 나머지는 그대로 남는다", () => {
  for (const drop of WEBSTORM_DROPS) {
    expect(!webstorm.some((b) => b.command === drop.command && b.keys.join(" ") === drop.keys.join(" ")), `남아 있음 ${drop.command} ${drop.keys}`);
    expect(BINDINGS.some((b) => b.command === drop.command && b.keys.join(" ") === drop.keys.join(" ")), `VS Code 표에 없는 drop ${drop.command}`);
  }
  expect(WEBSTORM_DROPS.length === 6, `drop ${WEBSTORM_DROPS.length}개`);
  const kept = BINDINGS.filter((b) => !WEBSTORM_DROPS.some((d) => d.command === b.command && d.keys.join(" ") === b.keys.join(" ")));
  same(webstorm.slice(WEBSTORM_BINDINGS.length), kept, "VS Code 줄 순서");
  return `${kept.length} 줄 유지`;
});

test("webstorm 표: 유지한 키는 에디터 밖에서 VS Code 표와 같은 뜻이다", () => {
  const pairs: [string, string][] = [["Meta+KeyB", "toggleSidebar"], ["Meta+KeyL", "focusChatInput"], ["Meta+KeyR", "reloadWindow"], ["Meta+Equal", "zoomIn"], ["Meta+Minus", "zoomOut"], ["Meta+Digit1", "focusPaneIndex:0"], ["Meta+Digit9", "focusPaneIndex:last"], ["Meta+KeyP", "quickOpen"], ["Shift+Meta+KeyA", "focusApproval"], ["Meta+Period", "pass"]];
  for (const [stroke, command] of pairs) {
    const web = verdict(stroke, outside);
    const code = verdict(stroke, outside, BINDINGS);
    if (command === "pass") expect(web === "pass" && code === "pass", `${stroke}: ${web}, ${code}`);
    else expect(web === command && code === command, `${stroke}: ${web}, ${code}`);
  }
  return "ok";
});

test("stepKey: 에디터 안에서는 WebStorm 뜻", () => {
  const wanted: [string, string][] = [
    ["Meta+KeyB", "editor:goToDeclaration"],
    ["Meta+KeyD", "editor:duplicateSelection"],
    ["Alt+ArrowUp", "editor:smartSelectExpand"],
    ["Alt+ArrowDown", "editor:smartSelectShrink"],
    ["Alt+Shift+ArrowDown", "editor:moveLinesDown"],
    ["Shift+Meta+KeyA", "commandPalette"],
    ["Meta+Backspace", "editor:deleteLines"],
    ["Meta+KeyL", "gotoLine"],
    ["Alt+Enter", "quickFix"],
    ["Meta+Period", "editor:toggleFold"],
    ["Meta+KeyR", "editor:startFindReplace"],
    ["Ctrl+KeyJ", "editor:showHover"],
    ["Ctrl+Shift+KeyJ", "editor:joinLines"],
    ["Meta+BracketLeft", "editor:navigateBack"],
    ["Alt+Meta+ArrowRight", "editor:navigateForward"],
    ["F2", "nextProblem"],
    ["Shift+F6", "editor:rename"],
    ["Meta+KeyP", "editor:triggerParameterHints"],
    ["Ctrl+KeyG", "editor:addSelectionToNextFindMatch"],
  ];
  for (const [stroke, command] of wanted) expect(verdict(stroke, inEditor) === command, `${stroke}: ${verdict(stroke, inEditor)}`);
  return `${wanted.length}개`;
});

test("stepKey: 에디터 밖에서는 앱의 뜻이고 어디서나 듣는 키는 그대로 연다", () => {
  expect(verdict("Meta+KeyB", outside) === "toggleSidebar", "⌘B 사이드바");
  expect(verdict("Shift+Meta+KeyA", outside) === "focusApproval", "⇧⌘A 승인 카드");
  expect(verdict("Meta+KeyD", outside) === "pass", "⌘D 는 에디터 밖에서 아무 뜻도 아님");
  for (const [stroke, command] of [["Shift+Meta+KeyO", "quickOpen"], ["Meta+KeyE", "quickOpen"], ["Meta+KeyO", "symbols"], ["Alt+Meta+KeyO", "symbols"], ["Shift+Meta+KeyR", "replaceInFiles"], ["Alt+F12", "toggleBottom"], ["Shift+Meta+BracketLeft", "previousEditor"], ["Shift+Meta+BracketRight", "nextEditor"]]) {
    expect(verdict(stroke, outside) === command && verdict(stroke, inEditor) === command, `${stroke} ${verdict(stroke, outside)}`);
  }
  return "ok";
});

test("stepKey: 뺀 VS Code 키는 WebStorm 에서 뜻이 없다", () => {
  expect(verdict("Meta+Period", inEditor) === "editor:toggleFold", "⌘. 은 접기");
  expect(verdict("Ctrl+KeyG", inEditor) === "editor:addSelectionToNextFindMatch", "⌃G 는 다음 일치 선택");
  expect(verdict("Alt+Meta+ArrowLeft", outside) === "pass" && verdict("Alt+Meta+ArrowRight", outside) === "pass", "⌥⌘←→ 는 에디터 밖에서 비어 있다");
  expect(verdict("Shift+Meta+KeyO", inEditor, BINDINGS) === "gotoSymbol", "VS Code 에서는 파일 안 심볼");
  return "ok";
});

test("chord: ⌘K 는 WebStorm 에서도 chord 를 기다린다", () => {
  const first = stepKey(null, "Meta+KeyK", outside, 0, webstorm);
  expect(first.kind === "pending", "⌘K pending");
  const second = stepKey(first.kind === "pending" ? first.pending : null, "Meta+Backslash", outside, 100, webstorm);
  expect(second.kind === "run" && second.command === "splitDown", "⌘K ⌘\\");
  const inside = stepKey(null, "Meta+KeyK", inEditor, 0, webstorm);
  expect(inside.kind === "pending", "에디터 안 ⌘K");
  return "ok";
});

test("stepKey 기본 표는 활성 프리셋을 따른다", () => {
  try {
    setKeymapPreset("webstorm");
    expect(activeBindings() === webstorm, "활성 표");
    const step = stepKey(null, "Meta+KeyD", inEditor, 0);
    expect(step.kind === "run" && step.command === "editor:duplicateSelection", "기본 인자");
    setKeymapPreset("vscode");
    expect(stepKey(null, "Meta+KeyD", inEditor, 0).kind === "pass", "vscode 로 돌아옴");
  } finally {
    setKeymapPreset("vscode");
  }
  return "ok";
});

test("가로채기 집합: vscode 표의 값이 기존 상수와 같다", () => {
  same([...interceptStrokes(BINDINGS)].sort(), [...INTERCEPT_STROKES].sort(), "intercept");
  same([...browserStrokes(BINDINGS)].sort(), [...BROWSER_STROKES].sort(), "browser");
  same([...keyupAwareStrokes(BINDINGS)].sort(), ["Meta+KeyP", "Shift+Meta+KeyP"], "keyup");
  same([...KEYUP_AWARE_STROKES].sort(), ["Meta+KeyP", "Shift+Meta+KeyP"], "keyup 상수");
  return `${INTERCEPT_STROKES.size}개`;
});

test("가로채기 집합: webstorm 은 어디서나 듣는 키만 가로채고 에디터 전용 키는 페이지로 보낸다", () => {
  const intercept = interceptStrokes(webstorm);
  for (const stroke of ["Meta+KeyO", "Alt+Meta+KeyO", "Shift+Meta+KeyR", "Alt+F12", "Shift+Meta+BracketLeft", "Shift+Meta+BracketRight"]) expect(intercept.has(stroke), `가로챔 ${stroke}`);
  for (const stroke of ["Meta+KeyD", "Meta+KeyY", "Alt+ArrowUp", "Meta+Backspace", "Alt+Enter", "Meta+KeyP"]) expect(!intercept.has(stroke), `가로채지 않음 ${stroke}`);
  for (const stroke of ["Meta+KeyB", "Meta+KeyL", "Meta+KeyR", "Shift+Meta+KeyA"]) expect(intercept.has(stroke), `가로챔 ${stroke}`);
  return `${intercept.size}개`;
});

test("가로채기 집합: 빠른 열기 키는 ⌘ 를 뗄 때 동작해서 가로채지 않는다(⇧⌘O, ⌘E 포함)", () => {
  const keyup = keyupAwareStrokes(webstorm);
  same([...keyup].sort(), ["Meta+KeyE", "Meta+KeyP", "Shift+Meta+KeyO", "Shift+Meta+KeyP"], "keyup");
  const intercept = interceptStrokes(webstorm);
  for (const stroke of keyup) expect(!intercept.has(stroke), `가로채지 않음 ${stroke}`);
  return "4개";
});

test("에디터가 표에 넘기는 키: vscode 는 없고 webstorm 은 에디터에서 참이 될 수 있는 줄만", () => {
  expect(editorTakenStrokes("vscode").size === 0, "vscode 는 비어 있다");
  const taken = editorTakenStrokes("webstorm");
  for (const stroke of ["Meta+KeyD", "Alt+ArrowUp", "Alt+Shift+ArrowUp", "Meta+Backspace", "Meta+KeyE", "Alt+F12", "Meta+F12", "F2", "Meta+BracketLeft", "Shift+Enter", "Alt+Enter"]) expect(taken.has(stroke), `먹음 ${stroke}`);
  for (const stroke of ["Escape", "Enter", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Meta+KeyS", "Meta+KeyK"]) expect(!taken.has(stroke), `먹지 않음 ${stroke}`);
  // 에디터 안에서 거짓인 조건(notEditor 등)의 줄은 없다
  for (const b of WEBSTORM_BINDINGS) expect(b.when !== "notEditor" && b.when !== "notEditorOrComposer", `에디터 밖 조건 ${b.command}`);
  return `${taken.size}개`;
});

test("메뉴 가속키: Electron 표기로 바꾸고 chord 와 모르는 키는 거른다", () => {
  const wanted: [string, string | null][] = [
    ["Shift+Meta+KeyO", "Shift+Cmd+O"],
    ["Alt+Meta+Equal", "Alt+Cmd+="],
    ["Meta+BracketLeft", "Cmd+["],
    ["Alt+Meta+ArrowLeft", "Alt+Cmd+Left"],
    ["Alt+F12", "Alt+F12"],
    ["Meta+Digit0", "Cmd+0"],
    ["Meta+NumpadAdd", "Cmd+numadd"],
    ["Meta+Numpad0", "Cmd+num0"],
    ["Ctrl+Alt+KeyR", "Ctrl+Alt+R"],
    ["Meta+Backslash", "Cmd+\\"],
    ["Meta+IntlRo", null],
  ];
  for (const [stroke, accelerator] of wanted) expect(acceleratorOf(stroke) === accelerator, `${stroke}: ${acceleratorOf(stroke)}`);
  expect(menuAccelerator(webstorm, "quickOpen") === "Shift+Cmd+O", "빠른 열기는 첫 줄");
  expect(menuAccelerator(webstorm, "toggleSidebar") === "Cmd+B", "사이드바");
  expect(menuAccelerator(webstorm, "gotoLine") === null && menuAccelerator(webstorm, "gotoSymbol") === null, "에디터 전용 키는 메뉴에 두지 않는다");
  expect(menuAccelerator(webstorm, "sessionPrev") === null, "표에 없는 명령");
  expect(menuAccelerator(BINDINGS, "gotoLine") === null, "VS Code 의 ⌃G 는 에디터 영역 전용");
  expect(menuAccelerator(webstorm, "zoomReset") === "Cmd+0" && menuAccelerator(BINDINGS, "zoomReset") === "Cmd+0", "숫자 패드 키보다 ⌘0");
  const menuStrokes = new Set(["CommandOrControl+C", "CommandOrControl+M", "Shift+CommandOrControl+Z", "Cmd+\\"].map((a) => strokeOfAccelerator(a)!));
  expect([...menuStrokes].join(" ") === "Meta+KeyC Meta+KeyM Shift+Meta+KeyZ Meta+Backslash", `메뉴 가속키를 키로 ${[...menuStrokes].join(" ")}`);
  expect([...chordFollowersOf(BINDINGS, "Meta+KeyK", menuStrokes)].sort().join(" ") === "Meta+Backslash Meta+KeyC Meta+KeyM", "⌘K 다음의 메뉴 키");
  return "ok";
});

test("단축키 목록: webstorm 키가 기호로 읽힌다", () => {
  const labels: [string, string][] = [["Meta+BracketLeft", "⌘["], ["Alt+Meta+BracketRight", "⌥⌘]"], ["Shift+Meta+Equal", "⇧⌘="], ["Meta+Backspace", "⌘⌫"], ["Alt+Enter", "⌥↵"], ["Alt+F7", "⌥F7"], ["Meta+Period", "⌘."], ["Ctrl+Alt+ArrowDown", "⌃⌥↓"]];
  for (const [stroke, label] of labels) expect(strokeLabel(stroke) === label, `${stroke}: ${strokeLabel(stroke)}`);
  for (const b of WEBSTORM_BINDINGS) expect(!/Bracket|Key[A-Z]|Digit/.test(strokeLabel(b.keys[0])), `기호로 못 읽음 ${b.keys[0]}`);
  const rows = shortcutRows(webstorm);
  const row = rows.find((r) => r.command === "editor:goToDeclaration");
  expect(!!row && row.keys.some((k) => k.join("") === "⌘B"), "Go to Declaration ⌘B");
  const missing = WEBSTORM_BINDINGS.filter((b) => !rows.some((r) => r.command === b.command));
  expect(missing.length === 0, `목록에 없는 명령 ${missing.map((b) => b.command)}`);
  return `${rows.length}행`;
});

test("키 바꾸기: 겹치는 맥락의 같은 키만 충돌로 본다", () => {
  same(findConflicts(BINDINGS, "toggleSidebar", "Meta+KeyJ", undefined), ["toggleBottom"], "⌘J");
  same(findConflicts(BINDINGS, "terminalFind", "Meta+KeyI", "terminal"), ["terminalAsk", "quickAsk"], "터미널 ⌘I");
  same(findConflicts(BINDINGS, "terminalFind", "Alt+Meta+BracketLeft", "terminal"), [], "에디터 전용 키는 터미널과 겹치지 않는다");
  same(findConflicts(BINDINGS, "toggleSidebar", "Meta+KeyB", undefined), [], "자기 키");
  return "ok";
});

test("키 바꾸기: Reassign 은 키를 가져오고 다른 명령은 그 키만 잃는다", () => {
  const overrides = assignKeys(BINDINGS, undefined, "toggleSidebar", "Meta+KeyJ", ["toggleBottom"]);
  same(overrides, { toggleSidebar: ["Meta+KeyJ"], toggleBottom: [] }, "overrides");
  const bindings = bindingsFor("vscode", overrides);
  same(keysOf(bindings, "toggleSidebar"), ["Meta+KeyJ"], "sidebar");
  same(keysOf(bindings, "toggleBottom"), [], "bottom");
  expect(verdict("Meta+KeyJ", outside, bindings) === "toggleSidebar", "⌘J 는 사이드바");
  expect(verdict("Meta+KeyB", outside, bindings) === "pass", "⌘B 는 비었다");
  expect(menuAccelerator(bindings, "toggleSidebar") === "Cmd+J" && menuAccelerator(bindings, "toggleBottom") === null, "메뉴 가속키");
  const feedback = assignKeys(BINDINGS, undefined, "toggleSidebar", "Shift+Meta+KeyX", ["feedback"]);
  same(feedback.feedback, ["Alt+Meta+KeyF"], "키가 둘이면 가져간 키만 빠진다");
  return "ok";
});

test("키 바꾸기: 기본값으로 돌리면 덮어쓴 값이 지워지고, 되돌리기는 그 명령만 지운다", () => {
  same(assignKeys(BINDINGS, { toggleSidebar: ["Meta+KeyJ"] }, "toggleSidebar", "Meta+KeyB"), {}, "기본값과 같다");
  same(resetKeys({ toggleSidebar: ["Meta+KeyJ"], toggleBottom: [] }, "toggleBottom"), { toggleSidebar: ["Meta+KeyJ"] }, "reset");
  return "ok";
});

test("키 바꾸기: chord 를 받고, 프리셋마다 따로 적용된다", () => {
  const overrides = assignKeys(BINDINGS, undefined, "toggleSidebar", "Meta+KeyK Meta+KeyT");
  const bindings = bindingsFor("vscode", overrides);
  const first = stepKey(null, "Meta+KeyK", outside, 0, bindings);
  expect(first.kind === "pending", "⌘K 대기");
  const second = stepKey(first.kind === "pending" ? first.pending : null, "Meta+KeyT", outside, 10, bindings);
  expect(second.kind === "run" && second.command === "toggleSidebar", "⌘K ⌘T");
  try {
    setKeymapOverrides({ webstorm: overrides });
    expect(activeBindings() === BINDINGS, "vscode 활성 표는 그대로");
    setKeymapPreset("webstorm");
    same(keysOf(activeBindings(), "toggleSidebar"), ["Meta+KeyK Meta+KeyT"], "webstorm 에 적용");
  } finally {
    setKeymapPreset("vscode");
    setKeymapOverrides(undefined);
  }
  return "ok";
});

test("키 바꾸기: 수정키 없는 첫 키는 기능 키만, 저장 값은 모양을 검사한다", () => {
  same(["KeyA", "Shift+KeyA", "Meta+KeyK", "Ctrl+Alt+KeyR", "F5", "Shift+F12", "Escape"].map((k) => isRecordableStroke(k, true)), [false, false, true, true, true, true, false], "첫 키");
  same(["KeyW", "Enter", "Escape"].map((k) => isRecordableStroke(k, false)), [true, true, false], "둘째 키");
  same(sanitizeKeymapOverrides({ vscode: { toggleSidebar: ["Meta+KeyJ", "Meta+KeyJ"], bad: "x", "x y": ["Meta+KeyA"], toggleBottom: ["meta+j"] }, other: {}, webstorm: [] }), { vscode: { toggleSidebar: ["Meta+KeyJ"] } }, "sanitize");
  same(sanitizeKeymapOverrides("nope"), {}, "객체가 아니다");
  return "ok";
});

test("키 바꾸기: 키를 잃은 명령도 단축키 목록에 남는다", () => {
  const overrides = { toggleBottom: [] };
  const rows = shortcutRows(bindingsFor("vscode", overrides), { changed: new Set(Object.keys(overrides)) });
  const row = rows.find((r) => r.command === "toggleBottom");
  expect(!!row && row.keys.length === 0 && row.changed, "Toggle Panel 행");
  expect(rows.find((r) => r.command === "toggleSidebar")?.changed === false, "바뀌지 않은 행");
  return "ok";
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
