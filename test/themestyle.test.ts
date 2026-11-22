import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-themestyle-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const { Store } = await import("../server/store");
const { THEME_STYLES } = await import("../shared/protocol");

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const bad = (value: unknown) => value as never;

type Token = { name: string; value: Record<string, string> };
const tokens = JSON.parse(readFileSync(new URL("../design-system/tokens.json", import.meta.url), "utf8")) as { color: { tokens: Token[]; styles: { id: string }[] } };
const css = readFileSync(new URL("../web/tokens.css", import.meta.url), "utf8");
const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/;

const specificity = (selector: string) => {
  const attributes = (selector.match(/\[[^\]]+\]/g) ?? []).length;
  return { ids: 0, classes: attributes + (selector.startsWith(":root") ? 1 : 0) };
};
const blockOf = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return null;
  return { start, body: css.slice(start, css.indexOf("\n}", start)) };
};

test("THEME_STYLES 는 lodestar 와 webstorm 이고 기본은 lodestar", () => {
  expect(JSON.stringify(THEME_STYLES) === JSON.stringify(["lodestar", "webstorm"]), JSON.stringify(THEME_STYLES));
  return expect(new Store().settings.themeStyle === "lodestar", "기본값");
});

test("updateSettings: 모르는 스타일은 버리고 기존 값을 유지한다", () => {
  const store = new Store();
  store.updateSettings({ themeStyle: "webstorm" });
  expect(store.settings.themeStyle === "webstorm", "webstorm 저장");
  store.updateSettings({ themeStyle: bad("solarized") });
  expect(store.settings.themeStyle === "webstorm", "모르는 값은 무시");
  store.updateSettings({ themeStyle: bad(3) });
  store.updateSettings({ themeStyle: bad(null) });
  expect(store.settings.themeStyle === "webstorm", "숫자, null 도 무시");
  store.updateSettings({ themeStyle: "lodestar" });
  return expect(store.settings.themeStyle === "lodestar", "lodestar 로 되돌림");
});

test("settings.json 을 손으로 고쳐 이상한 스타일이 들어가도 읽을 때 lodestar 로 되돌린다", () => {
  writeFileSync(join(process.env.AGENT_NAV_HOME as string, "settings.json"), JSON.stringify({ settingsVersion: 2, themeStyle: "neon" }));
  return expect(new Store().settings.themeStyle === "lodestar", "읽기 보정");
});

test("tokens.json: webstorm 값은 전부 유효한 16진수 색이고 기본 스타일 메타데이터가 있다", () => {
  expect(tokens.color.styles.some((s) => s.id === "webstorm") && tokens.color.styles.some((s) => s.id === "lodestar"), "styles 메타데이터");
  let count = 0;
  for (const token of tokens.color.tokens) {
    for (const key of ["webstorm-dark", "webstorm-light"]) {
      const value = token.value[key];
      if (value === undefined) continue;
      count++;
      expect(HEX.test(value), `${token.name} ${key} = ${value}`);
      expect(value !== token.value[key.endsWith("dark") ? "dark" : "light"], `${token.name} ${key} 가 기본과 같다(키를 만들 이유가 없음)`);
    }
  }
  return expect(count > 100, `덮어쓴 값 ${count}개`);
});

test("tokens.css: 다크와 라이트 WebStorm 블록이 있고 값이 tokens.json 과 같다", () => {
  const dark = blockOf(`[data-style="webstorm"]:not([data-theme="light"])`);
  const light = blockOf(`[data-style="webstorm"][data-theme="light"]`);
  expect(dark !== null && light !== null, "두 블록");
  const check = (block: { body: string }, key: string) => {
    let n = 0;
    for (const token of tokens.color.tokens) {
      const value = token.value[key];
      if (value === undefined) continue;
      n++;
      expect(block.body.includes(`  --${token.name}: ${value};`), `${key} ${token.name}`);
    }
    return n;
  };
  const d = check(dark!, "webstorm-dark");
  const l = check(light!, "webstorm-light");
  expect(!dark!.body.includes("color-scheme") && !light!.body.includes("color-scheme"), "color-scheme 은 밝기가 정한다");
  return `dark ${d}, light ${l}`;
});

test("tokens.css: 라이트 WebStorm 블록이 기본 라이트 블록을 이기고, 다크 블록은 라이트로 새지 않는다", () => {
  const plainLight = blockOf(`[data-theme="light"]`);
  expect(plainLight !== null, "기본 라이트 블록");
  const darkSelector = `[data-style="webstorm"]:not([data-theme="light"])`;
  const lightSelector = `[data-style="webstorm"][data-theme="light"]`;
  expect(specificity(lightSelector).classes > specificity(`[data-theme="light"]`).classes, "라이트 WebStorm 은 기본 라이트보다 구체적");
  expect(specificity(lightSelector).classes > specificity(`:root`).classes, "라이트 WebStorm 은 :root 보다 구체적");
  expect(darkSelector.includes(`:not([data-theme="light"])`), "다크 블록은 라이트를 제외");
  const dark = blockOf(darkSelector)!;
  const light = blockOf(lightSelector)!;
  expect(dark.start < light.start, "순서와 상관없지만 다크 블록이 먼저");
  return expect(/--surface-base: #2b2d30;/.test(dark.body) && /--surface-base: #f7f8fa;/.test(light.body), "surface-base 가 밝기마다 다름");
});

test("tokens.css: lodestar 값은 기본 :root 와 [data-theme=light] 블록에 그대로 있다", () => {
  const root = blockOf(`:root`)!;
  const plainLight = blockOf(`[data-theme="light"]`)!;
  for (const token of tokens.color.tokens) {
    expect(root.body.includes(`  --${token.name}: ${token.value.dark};`), `dark ${token.name}`);
    expect(plainLight.body.includes(`  --${token.name}: ${token.value.light};`), `light ${token.name}`);
  }
  return `${tokens.color.tokens.length}개`;
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
