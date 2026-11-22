import { GROUP_IDS, activeGroup, filterSettings, groupCounts, isModified, isNarrow, parseSettingNumber, decideNumberInput, type SettingMeta } from "../web/settingsSchema";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const meta = (id: string, group: SettingMeta["group"], title: string, description: string, modified = false, keywords = ""): SettingMeta => ({ id, group, groupLabel: group === "appearance" ? "Appearance" : "Editor", title, description, keywords, modified });
const ITEMS = [
  meta("uiLetterSpacing", "appearance", "Letter spacing", "Space between letters in the interface and chat, in em.", true),
  meta("chatFontSize", "appearance", "Chat text size", "Size of your messages and the replies, in px."),
  meta("editorFontSize", "editor", "Font size", "Size of code text, in px.", true),
  meta("editorLigatures", "editor", "Ligatures", "Join characters like => into one shape.", false, "calt liga"),
];

test("isModified: 같은 값, 숫자 오차, null, 객체", () => {
  expect(!isModified(-0.02, -0.02), "same number");
  expect(!isModified(0.1 + 0.2, 0.3), "float noise ignored");
  expect(isModified(-0.03, -0.02), "different number");
  expect(isModified(null, "x") && !isModified(null, null), "null");
  expect(!isModified({ a: 1 }, { a: 1 }) && isModified({ a: 1 }, {}), "objects by value");
  expect(isModified("inline", "split") && !isModified(true, true), "string and bool");
  return "ok";
});

test("filterSettings: 낱말 AND, 대소문자 무시, 묶음 이름과 키워드와 id", () => {
  const ids = (q: string, m = false) => filterSettings(ITEMS, q, m).map((i) => i.id).join(",");
  expect(ids("") === "uiLetterSpacing,chatFontSize,editorFontSize,editorLigatures", "empty query keeps all");
  expect(ids("LETTER") === "uiLetterSpacing", "case insensitive title");
  expect(ids("px") === "chatFontSize,editorFontSize", "description match");
  expect(ids("editor size") === "editorFontSize", "group label and title words together");
  expect(ids("calt") === "editorLigatures", "keyword");
  expect(ids("chatfontsize") === "chatFontSize", "setting id");
  expect(ids("letter px") === "", "all words must match");
  expect(ids("   ") === "uiLetterSpacing,chatFontSize,editorFontSize,editorLigatures", "blank query");
  return "ok";
});

test("filterSettings: 바뀐 것만", () => {
  const ids = (q: string) => filterSettings(ITEMS, q, true).map((i) => i.id).join(",");
  expect(ids("") === "uiLetterSpacing,editorFontSize", "modified only");
  expect(ids("size") === "editorFontSize", "modified and query");
  return "ok";
});

test("groupCounts", () => {
  const counts = groupCounts(filterSettings(ITEMS, "px", false));
  expect(counts.get("appearance") === 1 && counts.get("editor") === 1 && !counts.has("browser"), "counts per group");
  return "ok";
});

test("activeGroup: 스크롤 위치와 맨 아래", () => {
  const tops = [
    { id: "appearance" as const, top: 0 },
    { id: "layout" as const, top: 300 },
    { id: "editor" as const, top: 600 },
  ];
  expect(activeGroup(tops, 0, 40) === "appearance", "top");
  expect(activeGroup(tops, 259, 40) === "appearance", "just before layout minus slack");
  expect(activeGroup(tops, 260, 40) === "layout", "slack reaches layout");
  expect(activeGroup(tops, 700, 40) === "editor", "past last");
  expect(activeGroup(tops, 100, 40, true) === "editor", "bottom picks last group");
  expect(activeGroup([], 0, 40) === null, "empty");
  return "ok";
});

test("isNarrow: 600 미만에서 접는다", () => {
  expect(isNarrow(599) && !isNarrow(600) && !isNarrow(1000), "threshold");
  return "ok";
});

test("parseSettingNumber: 범위와 단위", () => {
  expect(parseSettingNumber("-0.02", -0.05, 0.05, 0.01) === -0.02, "valid");
  expect(parseSettingNumber("0.06", -0.05, 0.05, 0.01) === null, "above max");
  expect(parseSettingNumber("-0.051", -0.05, 0.05, 0.01) === null, "below min");
  expect(parseSettingNumber("0.025", -0.05, 0.05, 0.01) === null, "not a multiple of step");
  expect(parseSettingNumber("", 1, 2) === null && parseSettingNumber("abc", 1, 2) === null, "blank and text");
  expect(parseSettingNumber("19.5", 14, 40, 0.5) === 19.5, "half step");
  expect(parseSettingNumber("0.05", -0.05, 0.05, 0.01) === 0.05, "max boundary with float noise");
  return "ok";
});

test("GROUP_IDS 는 중복이 없다", () => {
  expect(new Set(GROUP_IDS).size === GROUP_IDS.length, "unique");
  return "ok";
});

test("C: decideNumberInput - 0.1 을 치는 중간 값이 저장 대상이 되지 않는다", () => {
  const steps = ["0", "0.", "0.1"].map((t) => decideNumberInput(t, -0.05, 0.05, 0.01, 0.02));
  expect(steps[0].action === "save" && steps[0].value === 0, "0 은 유효하지만 저장은 지연 뒤(호출하는 쪽 타이머)");
  expect(steps[1].action === "save", "0. 도 유효한 0");
  expect(steps[2].action === "problem" && steps[2].reason === "invalid", "0.1 은 범위 밖");
  return "ok";
});

test("C: decideNumberInput - 저장된 값과 같으면 idle, 단위가 안 맞으면 step 안내, 빈 칸은 invalid", () => {
  expect(decideNumberInput("0.02", -0.05, 0.05, 0.01, 0.02).action === "idle", "same");
  const stepOnly = decideNumberInput("0.015", -0.05, 0.05, 0.01, 0);
  expect(stepOnly.action === "problem" && stepOnly.reason === "step", "step");
  const empty = decideNumberInput("", -0.05, 0.05, 0.01, 0);
  expect(empty.action === "problem" && empty.reason === "invalid", "empty");
  const nan = decideNumberInput("abc", -0.05, 0.05, 0.01, 0);
  expect(nan.action === "problem" && nan.reason === "invalid", "nan");
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`PASS ${c.name}: ${c.run()}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}: ${(e as Error).message}`);
  }
}
if (failed) process.exit(1);
console.log(`${cases.length} passed`);
