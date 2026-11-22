import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-uitype-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const { Store } = await import("../server/store");
const { UI_TYPE_DEFAULTS, UI_TYPE_RANGES } = await import("../shared/protocol");
const { uiTypeVars, chatSizePatch, chatLineHeightFor } = await import("../web/uiType");

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const bad = (value: unknown) => value as never;

test("새 설정 파일의 기본값은 지금 화면 값과 같다", () => {
  const store = new Store();
  const s = store.settings;
  expect(s.uiLetterSpacing === -0.02, `letter spacing ${s.uiLetterSpacing}`);
  expect(s.chatFontSize === 13 && s.chatLineHeight === 19.5, `chat ${s.chatFontSize}/${s.chatLineHeight}`);
  return expect(s.uiFontFamily === UI_TYPE_DEFAULTS.uiFontFamily && s.uiFontFamily === '-apple-system, "system-ui", sans-serif', "font family is the --font-sans default");
});

test("범위 안의 값은 저장되고 파일에도 남는다", () => {
  const store = new Store();
  store.updateSettings({ uiLetterSpacing: -0.05, chatFontSize: 16, chatLineHeight: 24, uiFontFamily: "Georgia, serif" });
  expect(store.settings.uiLetterSpacing === -0.05 && store.settings.chatFontSize === 16 && store.settings.chatLineHeight === 24 && store.settings.uiFontFamily === "Georgia, serif", "in memory");
  const onDisk = JSON.parse(readFileSync(join(process.env.AGENT_NAV_HOME as string, "settings.json"), "utf8"));
  expect(onDisk.uiLetterSpacing === -0.05 && onDisk.chatFontSize === 16, "on disk");
  const again = new Store();
  return expect(again.settings.uiLetterSpacing === -0.05 && again.settings.chatLineHeight === 24, "survives a restart");
});

test("범위 경계값은 받고 밖은 거절한다(이전 값 유지)", () => {
  const store = new Store();
  store.updateSettings({ uiLetterSpacing: 0.05, chatFontSize: 24, chatLineHeight: 14 });
  expect(store.settings.uiLetterSpacing === 0.05 && store.settings.chatFontSize === 24 && store.settings.chatLineHeight === 14, "max, max, min boundaries accepted");
  store.updateSettings({ uiLetterSpacing: 0.06 });
  expect(store.settings.uiLetterSpacing === 0.05, "0.06 rejected");
  store.updateSettings({ uiLetterSpacing: -0.051 });
  expect(store.settings.uiLetterSpacing === 0.05, "-0.051 rejected");
  store.updateSettings({ chatFontSize: 9.9 });
  expect(store.settings.chatFontSize === 24, "9.9 rejected");
  store.updateSettings({ chatFontSize: 24.5 });
  expect(store.settings.chatFontSize === 24, "24.5 rejected");
  store.updateSettings({ chatLineHeight: 13 });
  expect(store.settings.chatLineHeight === 14, "13 rejected");
  store.updateSettings({ chatLineHeight: 41 });
  return expect(store.settings.chatLineHeight === 14, "41 rejected");
});

test("숫자가 아닌 값과 NaN, Infinity 는 거절한다", () => {
  const store = new Store();
  store.updateSettings({ uiLetterSpacing: -0.03, chatFontSize: 14, chatLineHeight: 20 });
  store.updateSettings({ uiLetterSpacing: bad("0.01"), chatFontSize: bad("13"), chatLineHeight: bad(null) });
  expect(store.settings.uiLetterSpacing === -0.03 && store.settings.chatFontSize === 14 && store.settings.chatLineHeight === 20, "strings and null ignored");
  store.updateSettings({ uiLetterSpacing: Number.NaN, chatFontSize: Number.POSITIVE_INFINITY, chatLineHeight: bad({}) });
  return expect(store.settings.uiLetterSpacing === -0.03 && store.settings.chatFontSize === 14 && store.settings.chatLineHeight === 20, "NaN, Infinity, object ignored");
});

test("자간은 0.01 단위로 반올림해 저장한다", () => {
  const store = new Store();
  store.updateSettings({ uiLetterSpacing: -0.023 });
  expect(store.settings.uiLetterSpacing === -0.02, `-0.023 -> ${store.settings.uiLetterSpacing}`);
  store.updateSettings({ uiLetterSpacing: 0.0149 });
  expect(store.settings.uiLetterSpacing === 0.01, `0.0149 -> ${store.settings.uiLetterSpacing}`);
  store.updateSettings({ uiLetterSpacing: 0.1 + 0.2 - 0.3 });
  return expect(store.settings.uiLetterSpacing === 0, "float noise becomes 0");
});

test("빈 글꼴 이름과 공백은 기본값으로 돌아가고, 문자열이 아니면 기본값이 된다", () => {
  const store = new Store();
  store.updateSettings({ uiFontFamily: "Georgia, serif" });
  store.updateSettings({ uiFontFamily: "   " });
  expect(store.settings.uiFontFamily === UI_TYPE_DEFAULTS.uiFontFamily, "blank resets to default");
  store.updateSettings({ uiFontFamily: "Georgia, serif" });
  store.updateSettings({ uiFontFamily: "" });
  expect(store.settings.uiFontFamily === UI_TYPE_DEFAULTS.uiFontFamily, "empty resets to default");
  store.updateSettings({ uiFontFamily: bad(42) });
  return expect(store.settings.uiFontFamily === UI_TYPE_DEFAULTS.uiFontFamily, "non-string becomes default");
});

test("옛 설정 파일(새 필드 없음)을 읽어도 기본값이 채워진다", () => {
  writeFileSync(join(process.env.AGENT_NAV_HOME as string, "settings.json"), JSON.stringify({ settingsVersion: 2, theme: "dark" }));
  const store = new Store();
  return expect(store.settings.uiLetterSpacing === -0.02 && store.settings.chatFontSize === 13 && store.settings.uiFontFamily === UI_TYPE_DEFAULTS.uiFontFamily, "defaults filled");
});

test("범위 상수는 화면 입력과 서버가 같이 쓴다", () => {
  return expect(UI_TYPE_RANGES.uiLetterSpacing.min === -0.05 && UI_TYPE_RANGES.uiLetterSpacing.max === 0.05 && UI_TYPE_RANGES.chatFontSize.min === 10 && UI_TYPE_RANGES.chatLineHeight.max === 40, "ranges");
});

test("uiTypeVars: 설정 값을 CSS 변수로 바꾼다", () => {
  const vars = uiTypeVars({ uiLetterSpacing: -0.05, uiFontFamily: "Georgia, serif", chatFontSize: 16, chatLineHeight: 24 });
  expect(vars["--ui-letter-spacing"] === "-0.05em" && vars["--font-sans"] === "Georgia, serif", "letter spacing and font");
  return expect(vars["--text-chat"] === "16px" && vars["--leading-chat"] === "24px", "chat size and line height");
});

test("uiTypeVars: 값이 없으면(옛 데몬) 기본값, 일부만 있으면 나머지는 기본값", () => {
  const none = uiTypeVars({});
  expect(none["--ui-letter-spacing"] === "-0.02em" && none["--text-chat"] === "13px" && none["--leading-chat"] === "19.5px" && none["--font-sans"] === UI_TYPE_DEFAULTS.uiFontFamily, "defaults");
  const some = uiTypeVars({ chatFontSize: 15 });
  return expect(some["--text-chat"] === "15px" && some["--ui-letter-spacing"] === "-0.02em", "partial");
});

test("chatSizePatch: 줄 높이가 기본 비율(1.5배)을 따르고 있으면 글자 크기와 같이 움직인다", () => {
  expect(chatLineHeightFor(13) === 19.5 && chatLineHeightFor(16) === 24 && chatLineHeightFor(11.5) === 17.5, "1.5x in 0.5 steps");
  const fromDefault = chatSizePatch({ chatFontSize: 13, chatLineHeight: 19.5 }, 16);
  expect(fromDefault.chatFontSize === 16 && fromDefault.chatLineHeight === 24, `default follows: ${JSON.stringify(fromDefault)}`);
  const missing = chatSizePatch({}, 16);
  expect(missing.chatLineHeight === 24, "missing fields count as defaults");
  const custom = chatSizePatch({ chatFontSize: 13, chatLineHeight: 30 }, 16);
  expect(custom.chatFontSize === 16 && !("chatLineHeight" in custom), "a line height the user chose stays");
  const back = chatSizePatch({ chatFontSize: 16, chatLineHeight: 24 }, 13);
  return expect(back.chatLineHeight === 19.5, "reset to 13 brings 19.5 back");
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
if (failed) process.exit(1);
console.log(`${cases.length} passed`);
