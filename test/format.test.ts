import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configuredFormatter, formatLanguages, formatOnSaveOf, languageIdOf, languageNameOf, parseFormatSettings, runFormat, type FormatSettings } from "../server/format";
import { findExtension, resolveOxfmt, resolvePrettier, type ResolveEnv } from "../server/formatTools";

const cases: { name: string; run: () => Promise<string> | string }[] = [];
const test = (name: string, run: () => Promise<string> | string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const base = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-format-")));
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const echo = (mark: string) => `#!/usr/bin/env node\nlet t="";process.stdin.on("data",d=>t+=d);process.stdin.on("end",()=>{process.stdout.write("[${mark} "+process.argv.slice(2).join(" ")+"]"+t)});\n`;

function fakeBin(dir: string, name: string, mark: string) {
  const script = join(dir, "node_modules", name, "bin", name);
  write(script, echo(mark));
  chmodSync(script, 0o755);
  write(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version: "3.0.0", bin: { [name]: `bin/${name}` } }));
  mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
  symlinkSync(script, join(dir, "node_modules/.bin", name));
}

function fakeExtension(extDir: string, folder: string, pkg: object) {
  write(join(extDir, folder, "package.json"), JSON.stringify(pkg));
}

function extensionsWith(name: string, kinds: ("oxc" | "prettier" | "eslint" | "biome")[]) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  if (kinds.includes("oxc")) fakeExtension(dir, "oxc.oxc-vscode-1.63.0", { name: "oxc-vscode", publisher: "oxc", displayName: "Oxc", version: "1.63.0" });
  if (kinds.includes("eslint")) fakeExtension(dir, "dbaeumer.vscode-eslint-3.0.34", { name: "vscode-eslint", publisher: "dbaeumer", displayName: "ESLint", version: "3.0.34" });
  if (kinds.includes("biome")) fakeExtension(dir, "biomejs.biome-3.7.1", { name: "biome", publisher: "biomejs", displayName: "Biome", version: "3.7.1" });
  if (kinds.includes("prettier")) {
    fakeExtension(dir, "esbenp.prettier-vscode-12.4.0", { name: "prettier-vscode", publisher: "esbenp", displayName: "Prettier - Code formatter", version: "12.4.0" });
    fakeBin(join(dir, "esbenp.prettier-vscode-12.4.0"), "prettier", "prettier-bundled");
  }
  return dir;
}

function envFor(extensionsDir: string, extra: Partial<ResolveEnv> = {}): ResolveEnv {
  const builtinExtensionsDir = join(base, "builtin");
  fakeExtension(builtinExtensionsDir, "json-language-features", { name: "json-language-features", displayName: "JSON Language Features (Built-in)", version: "1.0.0" });
  return { home: join(base, "home"), pathVar: "", extensionsDir, builtinExtensionsDir, globalRoots: async () => [], ...extra };
}

const settingsOf = (user: Record<string, unknown>, workspace: Record<string, unknown> = {}): FormatSettings => ({ user: parseFormatSettings(user), workspace: parseFormatSettings(workspace) });
const defaultFor = (id: string) => ({ "[typescript]": { "editor.defaultFormatter": id } });

test("VS Code 설정 병합: 언어별 값은 작업 폴더가 사용자 위, 그 언어별 값이 최상위 값보다 앞선다", () => {
  const user = { "[typescriptreact]": { "editor.defaultFormatter": "esbenp.prettier-vscode" }, "[typescript]": { "editor.defaultFormatter": "oxc.oxc-vscode" }, "eslint.format.enable": true };
  const workspace = { "[typescriptreact]": { "editor.defaultFormatter": "oxc.oxc-vscode" }, "editor.defaultFormatter": "esbenp.prettier-vscode", "editor.formatOnSave": true };
  const s = settingsOf(user, workspace);
  expect(configuredFormatter(s, "typescriptreact")?.id === "oxc.oxc-vscode" && configuredFormatter(s, "typescriptreact")?.scope === "workspace", "ws [tsx] beats user [tsx]");
  expect(configuredFormatter(s, "typescript")?.scope === "user", "user [ts] beats ws top-level");
  expect(configuredFormatter(s, "javascript")?.id === "esbenp.prettier-vscode", "ws top-level for js");
  expect(configuredFormatter(settingsOf({}), "json") === null, "nothing configured");
  expect(formatOnSaveOf(s) === true && formatOnSaveOf(settingsOf({ "editor.formatOnSave": false }, { "editor.formatOnSave": true })) === true && formatOnSaveOf(settingsOf({})) === null, "formatOnSave layering");
  const combined = parseFormatSettings({ "[typescript][javascript]": { "editor.defaultFormatter": "x.y" } });
  expect(combined.byLanguage.typescript === "x.y" && combined.byLanguage.javascript === "x.y", "chained language keys");
  expect(languageIdOf("a/b.tsx") === "typescriptreact" && languageIdOf("Makefile") === null, "language ids");
  expect(languageNameOf("a.tsx") === "TypeScript JSX" && languageNameOf("a.ts") === "TypeScript", "VS Code language names");
  return "ok";
});

test("확장 폴더: 최신 버전, .obsolete 건너뜀, %displayName% 는 nls 에서", () => {
  const dir = join(base, "ext-lookup");
  fakeExtension(dir, "oxc.oxc-vscode-1.9.0", { displayName: "Oxc old", version: "1.9.0" });
  fakeExtension(dir, "oxc.oxc-vscode-1.63.0", { displayName: "%name%", version: "1.63.0" });
  write(join(dir, "oxc.oxc-vscode-1.63.0", "package.nls.json"), JSON.stringify({ name: "Oxc" }));
  fakeExtension(dir, "oxc.oxc-vscode-nightly-2.0.0", { displayName: "Nightly", version: "2.0.0" });
  const found = findExtension(dir, "oxc.oxc-vscode");
  expect(found?.version === "1.63.0" && found.displayName === "Oxc", `latest: ${JSON.stringify(found)}`);
  write(join(dir, ".obsolete"), JSON.stringify({ "oxc.oxc-vscode-1.63.0": true }));
  expect(findExtension(dir, "oxc.oxc-vscode")?.version === "1.9.0", "obsolete skipped");
  expect(findExtension(dir, "nobody.nothing") === null, "missing");
  return "ok";
});

test("oxfmt 를 못 찾으면 대신 포맷하지 않고 VS Code 문구의 재료와 대안을 준다", async () => {
  const dir = join(base, "no-oxfmt");
  mkdirSync(join(dir, "src"), { recursive: true });
  const env = envFor(extensionsWith("ext-oxc-prettier", ["oxc", "prettier"]));
  const result = await runFormat({ dir, absolute: join(dir, "src/a.ts"), text: "x", settings: settingsOf(defaultFor("oxc.oxc-vscode")), env });
  expect(result.text === null && result.formatter === null, `no text: ${JSON.stringify(result)}`);
  expect(result.problem?.kind === "cannotFormat" && result.problem.extension === "Oxc" && /oxfmt was not found/.test(result.problem.detail ?? ""), `problem: ${JSON.stringify(result.problem)}`);
  expect(result.language === "TypeScript", "language name");
  expect(result.alternatives?.map((a) => a.formatter).join() === "prettier,tsserver", `alternatives: ${JSON.stringify(result.alternatives)}`);
  return JSON.stringify(result.problem);
});

test("사용자가 추가하지 않은 폴더(bundledOnly)는 그 폴더의 포맷터를 돌리지 않고 TypeScript 포맷만 남는다", async () => {
  const dir = join(base, "not-added");
  fakeBin(dir, "prettier", "prettier-repo");
  const env = envFor(extensionsWith("ext-not-added", ["prettier"]));
  const settings = settingsOf(defaultFor("esbenp.prettier-vscode"));
  const own = await runFormat({ dir, absolute: join(dir, "a.ts"), text: "x", settings, env });
  expect(own.text === "[prettier-repo --stdin-filepath " + join(dir, "a.ts") + " --ignore-path " + join(dir, ".prettierignore") + "]x", `added folder uses its prettier: ${own.text}`);
  const blocked = await runFormat({ dir, absolute: join(dir, "a.ts"), text: "x", settings, env, bundledOnly: true });
  expect(blocked.text === null && blocked.problem?.kind === "cannotFormat" && blocked.problem.detail === "This folder was not added as a workspace (a pull request checkout or a repository Lodestar downloaded), so its formatters and their config files are not run.", `blocked: ${JSON.stringify(blocked.problem)}`);
  expect(blocked.alternatives?.map((a) => a.formatter).join() === "tsserver", `only tsserver: ${JSON.stringify(blocked.alternatives)}`);
  return "ok";
});

test("설정한 확장이 안 깔려 있으면 unavailable, 깔렸지만 agent-nav 가 못 돌리면 unsupported", async () => {
  const dir = join(base, "ext-missing");
  mkdirSync(dir, { recursive: true });
  const none = envFor(extensionsWith("ext-none", []));
  const missing = await runFormat({ dir, absolute: join(dir, "a.ts"), text: "x", settings: settingsOf(defaultFor("oxc.oxc-vscode")), env: none });
  expect(missing.problem?.kind === "unavailable" && missing.problem.extensionId === "oxc.oxc-vscode" && missing.text === null, `unavailable: ${JSON.stringify(missing.problem)}`);
  const biome = envFor(extensionsWith("ext-biome", ["biome"]));
  const unsupported = await runFormat({ dir, absolute: join(dir, "a.ts"), text: "x", settings: settingsOf(defaultFor("biomejs.biome")), env: biome });
  expect(unsupported.problem?.kind === "unsupported" && unsupported.problem.extension === "Biome", `unsupported: ${JSON.stringify(unsupported.problem)}`);
  const builtin = await runFormat({ dir, absolute: join(dir, "a.json"), text: "{}", settings: settingsOf({ "[json]": { "editor.defaultFormatter": "vscode.json-language-features" } }), env: biome });
  expect(builtin.problem?.kind === "unsupported" && builtin.problem.extension.startsWith("JSON Language Features"), `builtin: ${JSON.stringify(builtin.problem)}`);
  return "ok";
});

test("oxfmt 를 찾는 순서: 지정 경로, 작업 폴더 .bin, 하위 패키지, 상위 폴더 모듈, 전역, PATH", async () => {
  const env = envFor(extensionsWith("ext-order", ["oxc"]));
  const parent = join(base, "order-parent");
  fakeBin(parent, "oxfmt", "parent");
  const ws = join(parent, "app");
  mkdirSync(join(ws, "src"), { recursive: true });
  let found = await resolveOxfmt({ workspaceDir: ws, file: join(ws, "src/a.ts"), flat: {}, env });
  expect(found.tool?.origin === "module" && found.tool.path.includes("order-parent/node_modules/oxfmt"), `parent module: ${JSON.stringify(found.tool)}`);
  const globalRoot = join(base, "order-global", "node_modules");
  fakeBin(join(base, "order-global"), "oxfmt", "global");
  const ws2 = join(base, "order-solo");
  mkdirSync(ws2, { recursive: true });
  found = await resolveOxfmt({ workspaceDir: ws2, file: join(ws2, "a.ts"), flat: {}, env: { ...env, globalRoots: async () => [globalRoot] } });
  expect(found.tool?.origin === "global", `global: ${JSON.stringify(found.tool)}`);
  const mono = join(base, "order-mono");
  fakeBin(join(mono, "packages/web"), "oxfmt", "nested");
  write(join(mono, "packages/web/package.json"), "{}");
  mkdirSync(join(mono, "packages/web/src"), { recursive: true });
  found = await resolveOxfmt({ workspaceDir: mono, file: join(mono, "packages/web/src/a.ts"), flat: {}, env });
  expect(found.tool?.origin === "package", `nested package: ${JSON.stringify(found.tool)}`);
  fakeBin(mono, "oxfmt", "root");
  found = await resolveOxfmt({ workspaceDir: mono, file: join(mono, "packages/web/src/a.ts"), flat: {}, env });
  expect(found.tool?.origin === "workspace", "workspace bin first");
  const custom = join(base, "custom-oxfmt.js");
  write(custom, echo("custom"));
  found = await resolveOxfmt({ workspaceDir: mono, file: join(mono, "a.ts"), flat: { "oxc.path.oxfmt": custom }, env });
  expect(found.tool?.origin === "configured" && found.tool.loader === "node", "configured path");
  found = await resolveOxfmt({ workspaceDir: mono, file: join(mono, "a.ts"), flat: { "oxc.path.oxfmt": join(base, "nope") }, env });
  expect(found.tool === null && /does not exist/.test(found.why), `configured but missing: ${found.why}`);
  found = await resolveOxfmt({ workspaceDir: mono, file: join(mono, "a.ts"), flat: { "oxc.path.oxfmt": "${userHome}/x;rm" }, env });
  expect(found.tool === null && /rejects/.test(found.why), "shell characters rejected");
  const bin = join(base, "pathbin");
  write(join(bin, "oxfmt"), "#!/bin/sh\ncat\n");
  chmodSync(join(bin, "oxfmt"), 0o755);
  found = await resolveOxfmt({ workspaceDir: ws2, file: join(ws2, "a.ts"), flat: {}, env: { ...env, pathVar: `/nonexistent:${bin}` } });
  expect(found.tool?.origin === "path" && found.tool.loader === "native", "PATH");
  return "ok";
});

test("oxfmt 가 있으면 --stdin-filepath 로 돌리고, oxc.fmt.configPath 와 disableNestedConfig 를 넘긴다", async () => {
  const dir = join(base, "with-oxfmt");
  fakeBin(dir, "oxfmt", "oxfmt");
  mkdirSync(join(dir, "src"), { recursive: true });
  const env = envFor(extensionsWith("ext-oxc", ["oxc"]));
  const abs = join(dir, "src/a.ts");
  const plain = await runFormat({ dir, absolute: abs, text: "x", settings: settingsOf(defaultFor("oxc.oxc-vscode")), env });
  expect(plain.formatter === "oxc" && plain.text === `[oxfmt --stdin-filepath ${abs}]x` && !plain.problem, `plain: ${plain.text}`);
  const tuned = await runFormat({ dir, absolute: abs, text: "x", settings: settingsOf(defaultFor("oxc.oxc-vscode"), { "oxc.fmt.configPath": "cfg/fmt.json", "oxc.fmt.disableNestedConfig": true }), env });
  expect(tuned.text === `[oxfmt --stdin-filepath ${abs} -c ${join(dir, "cfg/fmt.json")} --disable-nested-config]x`, `tuned: ${tuned.text}`);
  const off = await runFormat({ dir, absolute: abs, text: "x", settings: settingsOf(defaultFor("oxc.oxc-vscode"), { "oxc.enable.oxfmt": false }), env });
  expect(off.problem?.kind === "cannotFormat" && /turned off/.test(off.problem.detail ?? "") && off.text === null, "oxc.enable.oxfmt false means the extension provides no formatter");
  const master = await runFormat({ dir, absolute: abs, text: "x", settings: settingsOf(defaultFor("oxc.oxc-vscode"), { "oxc.enable": false }), env });
  expect(master.problem?.kind === "cannotFormat", "oxc.enable false");
  const selection = await runFormat({ dir, absolute: abs, text: "x", range: { from: 0, to: 1 }, settings: settingsOf(defaultFor("oxc.oxc-vscode")), env });
  expect(selection.text === null && selection.problem?.kind === "selectionUnsupported" && selection.problem.extension === "Oxc", `selection: ${JSON.stringify(selection.problem)}`);
  return "ok";
});

test("prettier: 프로젝트의 것이 앞서고 없으면 확장에 번들된 것, 범위와 ignore 와 config 인자", async () => {
  const env = envFor(extensionsWith("ext-pretty", ["prettier"]));
  const settings = settingsOf({ "editor.defaultFormatter": "esbenp.prettier-vscode" });
  const local = join(base, "pretty-local");
  fakeBin(local, "prettier", "local");
  mkdirSync(join(local, "src"), { recursive: true });
  const abs = join(local, "src/A.tsx");
  const ignore = join(local, ".prettierignore");
  write(ignore, "dist\n");
  const whole = await runFormat({ dir: local, absolute: abs, text: "x", settings, env });
  expect(whole.formatter === "prettier" && whole.text === `[local --stdin-filepath ${abs} --ignore-path ${ignore}]x`, `local whole: ${whole.text}`);
  const ranged = await runFormat({ dir: local, absolute: abs, text: "x", range: { from: 1, to: 5 }, settings, env });
  expect(ranged.text === `[local --stdin-filepath ${abs} --ignore-path ${ignore} --range-start 1 --range-end 5]x`, `range: ${ranged.text}`);
  const flags = await runFormat({ dir: local, absolute: abs, text: "x", settings: settingsOf({ "editor.defaultFormatter": "esbenp.prettier-vscode", "prettier.useEditorConfig": false, "prettier.configPath": ".cfg/p.json" }), env });
  expect(flags.text?.includes(`--config ${join(local, ".cfg/p.json")} --no-editorconfig`) === true, `flags: ${flags.text}`);
  const bare = join(base, "pretty-bare");
  mkdirSync(bare, { recursive: true });
  const bundled = await runFormat({ dir: bare, absolute: join(bare, "a.ts"), text: "x", settings, env });
  expect(bundled.formatter === "prettier" && bundled.text?.startsWith("[prettier-bundled ") === true, `bundled: ${bundled.text}`);
  const found = resolvePrettier({ workspaceDir: bare, file: join(bare, "a.ts"), flat: {}, env });
  expect(found.tool?.origin === "bundled", "origin bundled");
  const required = await runFormat({ dir: bare, absolute: join(bare, "a.ts"), text: "x", settings: settingsOf({ "editor.defaultFormatter": "esbenp.prettier-vscode", "prettier.requireConfig": true }), env });
  expect(required.problem?.kind === "cannotFormat" && /requireConfig/.test(required.problem.detail ?? ""), "requireConfig without a config file");
  const noExt = await runFormat({ dir: bare, absolute: join(bare, "a.ts"), text: "x", settings: settingsOf({ "editor.defaultFormatter": "esbenp.prettier-vscode" }), env: envFor(extensionsWith("ext-pretty-none", [])) });
  expect(noExt.problem?.kind === "unavailable", "extension not installed");
  return "ok";
});

test("agent-nav 에서 고른 포맷터가 VS Code 설정보다 앞서고, 이번 한 번 지정은 그보다 앞선다", async () => {
  const dir = join(base, "chosen");
  fakeBin(dir, "oxfmt", "oxfmt");
  const env = envFor(extensionsWith("ext-chosen", ["oxc", "prettier"]));
  const settings = settingsOf(defaultFor("oxc.oxc-vscode"));
  const abs = join(dir, "a.ts");
  const viaChoice = await runFormat({ dir, absolute: abs, text: "x", settings, chosen: { typescript: "prettier" }, env });
  expect(viaChoice.formatter === "prettier", "chosen prettier");
  const once = await runFormat({ dir, absolute: abs, text: "x", settings, chosen: { typescript: "prettier" }, formatter: "tsserver", env });
  expect(once.formatter === "tsserver" && once.text === null && !once.problem, "one-off tsserver means the screen formats with LSP");
  const onceOxc = await runFormat({ dir, absolute: abs, text: "x", range: { from: 0, to: 1 }, settings, formatter: "oxc", env });
  expect(onceOxc.problem?.kind === "selectionUnsupported", "one-off still respects selection limits");
  return "ok";
});

test("기본 포맷터를 안 골랐으면 후보가 하나일 때만 쓰고, 둘이면 ambiguous, 없으면 none", async () => {
  const dir = join(base, "nodefault");
  mkdirSync(dir, { recursive: true });
  const prettierOnly = envFor(extensionsWith("ext-pretty-only", ["prettier"]));
  const one = await runFormat({ dir, absolute: join(dir, "a.md"), text: "x", settings: settingsOf({}), env: prettierOnly });
  expect(one.formatter === "prettier", "a single provider is used");
  fakeBin(dir, "oxfmt", "oxfmt");
  const both = envFor(extensionsWith("ext-both", ["prettier", "oxc"]));
  const many = await runFormat({ dir, absolute: join(dir, "a.md"), text: "x", settings: settingsOf({}), env: both });
  expect(many.text === null && many.problem?.kind === "ambiguous" && many.alternatives?.length === 2, `ambiguous: ${JSON.stringify(many)}`);
  const configured = join(base, "nodefault-config");
  fakeBin(configured, "oxfmt", "oxfmt");
  write(join(configured, ".oxfmtrc.json"), "{}");
  const picked = await runFormat({ dir: configured, absolute: join(configured, "a.md"), text: "x", settings: settingsOf({}), env: both });
  expect(picked.formatter === "oxc" && !picked.problem, `the repo's only formatter config decides: ${JSON.stringify(picked)}`);
  write(join(configured, ".prettierrc"), "{}");
  const bothConfigured = await runFormat({ dir: configured, absolute: join(configured, "a.md"), text: "x", settings: settingsOf({}), env: both });
  expect(bothConfigured.problem?.kind === "ambiguous", "two configs still ask");
  const empty = join(base, "nodefault-empty");
  mkdirSync(empty, { recursive: true });
  const nothing = await runFormat({ dir: empty, absolute: join(empty, "a.md"), text: "x", settings: settingsOf({}), env: envFor(extensionsWith("ext-empty", [])) });
  expect(nothing.problem?.kind === "none", "none");
  const unknown = await runFormat({ dir: empty, absolute: join(empty, "Makefile"), text: "x", settings: settingsOf({}), env: both });
  expect(unknown.problem?.kind === "none", "unknown language");
  const tsOnly = await runFormat({ dir: empty, absolute: join(empty, "a.ts"), text: "x", settings: settingsOf({}), env: envFor(extensionsWith("ext-ts-only", [])) });
  expect(tsOnly.formatter === "tsserver" && tsOnly.text === null && !tsOnly.problem, "ts with no extension: the built-in TypeScript formatter is the only provider");
  return "ok";
});

test("ESLint: eslint.format.enable 이 켜져야 하고, 작업 폴더에서 찾고, 도구 오류는 던진다", async () => {
  const dir = join(base, "eslint-ws");
  mkdirSync(join(dir, "src"), { recursive: true });
  fakeBin(dir, "eslint", "eslint");
  const env = envFor(extensionsWith("ext-eslint", ["eslint"]));
  const abs = join(dir, "src/a.ts");
  const off = await runFormat({ dir, absolute: abs, text: "x", settings: settingsOf({ "editor.defaultFormatter": "dbaeumer.vscode-eslint" }), env });
  expect(off.problem?.kind === "cannotFormat" && off.problem.extension === "ESLint", "format.enable off");
  const json = await runFormat({ dir, absolute: join(dir, "a.json"), text: "{}", settings: settingsOf({ "editor.defaultFormatter": "dbaeumer.vscode-eslint", "eslint.format.enable": true }), env });
  expect(json.problem?.kind === "cannotFormat", "eslint does not format JSON");
  const broken = join(base, "eslint-broken");
  fakeBin(broken, "eslint", "x");
  write(join(broken, "node_modules/eslint/bin/eslint"), `#!/usr/bin/env node\nprocess.stdout.write("not json");process.exit(2)\n`);
  mkdirSync(join(broken, "src"), { recursive: true });
  let message = "";
  try {
    await runFormat({ dir: broken, absolute: join(broken, "src/a.ts"), text: "x", settings: settingsOf({ "editor.defaultFormatter": "dbaeumer.vscode-eslint", "eslint.format.enable": true }), env });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(/ESLint could not format this file/.test(message), `eslint error surfaces: ${message}`);
  return "ok";
});

test("언어별 포맷터 목록: VS Code 값과 출처, 고른 값, 고를 수 있는 포맷터", () => {
  const s = settingsOf({ "[typescriptreact]": { "editor.defaultFormatter": "esbenp.prettier-vscode" }, "[json]": { "editor.defaultFormatter": "vscode.json-language-features" } }, { "[typescriptreact]": { "editor.defaultFormatter": "oxc.oxc-vscode" } });
  const rows = formatLanguages(s, { markdown: "prettier" });
  const byId = (id: string) => rows.find((r) => r.id === id)!;
  expect(byId("typescriptreact").vscode.formatter === "oxc" && byId("typescriptreact").vscode.scope === "workspace", "tsx from workspace");
  expect(byId("json").vscode.raw === "vscode.json-language-features" && byId("json").vscode.formatter === null, "unknown extension keeps the raw id");
  expect(byId("markdown").chosen === "prettier" && byId("typescript").vscode.raw === null, "chosen and unset");
  expect(byId("css").options.map((o) => o.formatter).join() === "oxc,prettier" && byId("javascript").options.length === 4, "options per language");
  expect(byId("typescriptreact").name === "TypeScript JSX" && byId("typescriptreact").vscode.label === "oxfmt" && byId("typescriptreact").vscode.supported, "name and label");
  const eslintJson = formatLanguages(settingsOf({ "editor.defaultFormatter": "dbaeumer.vscode-eslint" }), {});
  expect(eslintJson.find((r) => r.id === "json")!.vscode.supported === false && eslintJson.find((r) => r.id === "javascript")!.vscode.supported === true, "ESLint is configured but cannot format JSON");
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok  ${c.name} - ${await c.run()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}\n  ${(error as Error).message}`);
  }
}
rmSync(base, { recursive: true, force: true });
if (failed) process.exit(1);
