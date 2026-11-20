import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-defaults-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const { DefaultsReader, defaultPaths, describeDefaults, fileIo, parseJsonc, readClaude, readVscode, resolveFrom, vscodeModelName } = await import("../server/defaults");
const { migrateSettings, Store } = await import("../server/store");
type Io = import("../server/defaults").DefaultsIo;
type Chosen = Parameters<typeof resolveFrom>[0];

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const NONE: Chosen = { defaultPermissionMode: null, defaultModel: null, defaultEffort: null, diffInlineWhenNarrow: null, requestQueuing: null, previewEditors: null };
const PATHS = { vscodeUserDir: "/fake/Code/User", claudeSettings: "/fake/claude/settings.json" };
// 가짜 파일과 가짜 state.vscdb 결과
const fakeIo = (files: Record<string, string>, state: Record<string, string>): Io => ({
  readText: (file) => files[file] ?? null,
  vscodeState: (key) => state[key] ?? null,
});
const VSCODE_SETTINGS = `{
  "claudeCode.initialPermissionMode": "bypassPermissions",
  "claudeCode.allowDangerouslySkipPermissions": true,
  "diffEditor.useInlineViewWhenSpaceIsLimited": false,
  "some.url": "https://example.com/a//b", /* block */
}`;
const MODEL_KEY = "chat.currentLanguageModel.panel.agent-host-claude";
const CONFIG_KEY = "chat.modelConfiguration.panel.agent-host-claude";
const SONNET = "agent-host-claude:@provider=anthropic:sonnet";
const CLAUDE_SETTINGS = JSON.stringify({ model: "opus", effortLevel: "high", permissions: { defaultMode: "auto" } });
const resolveWith = (files: Record<string, string>, state: Record<string, string>, chosen: Chosen = NONE) => {
  const io = fakeIo(files, state);
  return resolveFrom(chosen, readVscode(io, PATHS), readClaude(io, PATHS));
};
const vscodeFile = `${PATHS.vscodeUserDir}/settings.json`;

test("JSONC: comments and trailing commas go, // inside a string stays", () => {
  const parsed = parseJsonc(VSCODE_SETTINGS) as Record<string, unknown>;
  expect(parsed["some.url"] === "https://example.com/a//b", "url kept");
  return expect(parsed["claudeCode.initialPermissionMode"] === "bypassPermissions", "parsed");
});

test("Model key: provider prefix is dropped and %5B1m%5D decodes", () => {
  expect(vscodeModelName(SONNET) === "sonnet", "sonnet");
  expect(vscodeModelName("agent-host-claude:@provider=anthropic:opus%5B1m%5D") === "opus[1m]", "1m");
  return expect(vscodeModelName("agent-host-codex:@provider=openai:gpt-5.6-sol") === null, "other host ignored");
});

test("the user's real shape: VS Code sonnet, no thinkingLevel, ~/.claude high, bypass, no inline switch", () => {
  const r = resolveWith({ [vscodeFile]: VSCODE_SETTINGS, [PATHS.claudeSettings]: JSON.stringify({ model: "sonnet", effortLevel: "high", permissions: { defaultMode: "auto" } }) }, { [MODEL_KEY]: SONNET, [CONFIG_KEY]: JSON.stringify({ [SONNET]: {} }), "agentSessions.sorting": "created" });
  expect(r.model.value === "sonnet" && r.model.source === "vscode", "model from vscode");
  expect(r.effort.value === "high" && r.effort.source === "claude", "effort falls back to claude");
  expect(r.permissionMode.value === "bypassPermissions" && r.permissionMode.source === "vscode", "permission from vscode");
  expect(r.diffInlineWhenNarrow.value === false && r.diffInlineWhenNarrow.source === "vscode", "diff switch off from vscode");
  return expect(r.sessionSort.value === "created" && r.sessionSort.source === "vscode", "sort created from vscode");
});

test("Session sort: settings.json wins over the value VS Code keeps in state.vscdb", () => {
  const fromState = resolveWith({}, { "agentSessions.sorting": "created" });
  expect(fromState.sessionSort.value === "created" && fromState.sessionSort.source === "vscode", "state value");
  const fromSettings = resolveWith({ [vscodeFile]: JSON.stringify({ "agentSessions.sorting": "updated" }) }, { "agentSessions.sorting": "created" });
  expect(fromSettings.sessionSort.value === "updated", "settings.json first");
  return expect(resolveWith({}, { "agentSessions.sorting": "weird" }).sessionSort.source === "builtin", "unknown ignored");
});

test("VS Code thinkingLevel wins over ~/.claude effortLevel (and the encoded key matches)", () => {
  const key = "agent-host-claude:@provider=anthropic:opus%5B1m%5D";
  const r = resolveWith({ [PATHS.claudeSettings]: CLAUDE_SETTINGS }, { [MODEL_KEY]: key, [CONFIG_KEY]: JSON.stringify({ [key]: { thinkingLevel: "low" } }) });
  expect(r.model.value === "opus[1m]", "decoded model");
  return expect(r.effort.value === "low" && r.effort.source === "vscode", "thinkingLevel low");
});

test("An invalid thinkingLevel is ignored and falls through", () => {
  const r = resolveWith({ [PATHS.claudeSettings]: CLAUDE_SETTINGS }, { [MODEL_KEY]: SONNET, [CONFIG_KEY]: JSON.stringify({ [SONNET]: { thinkingLevel: "turbo" } }) });
  return expect(r.effort.value === "high" && r.effort.source === "claude", "claude effort");
});

test("Explicit agent-nav choice beats VS Code and ~/.claude", () => {
  const chosen: Chosen = { defaultPermissionMode: "plan", defaultModel: "haiku", defaultEffort: "max", diffInlineWhenNarrow: true, requestQueuing: null, previewEditors: null };
  const r = resolveWith({ [vscodeFile]: VSCODE_SETTINGS, [PATHS.claudeSettings]: CLAUDE_SETTINGS }, { [MODEL_KEY]: SONNET }, chosen);
  expect(r.model.value === "haiku" && r.model.source === "agent-nav", "model");
  expect(r.effort.value === "max" && r.effort.source === "agent-nav", "effort");
  expect(r.permissionMode.value === "plan" && r.permissionMode.source === "agent-nav", "permission");
  return expect(r.diffInlineWhenNarrow.value === true && r.diffInlineWhenNarrow.source === "agent-nav", "diff switch");
});

test("~/.claude is used when VS Code has nothing; 'auto' is an agent-nav mode (B3) and dontAsk falls to builtin", () => {
  const r = resolveWith({ [PATHS.claudeSettings]: CLAUDE_SETTINGS }, {});
  expect(r.model.value === "opus" && r.model.source === "claude", "model from claude");
  expect(r.effort.value === "high" && r.effort.source === "claude", "effort from claude");
  expect(r.permissionMode.value === "auto" && r.permissionMode.source === "claude", "auto taken");
  const dontAsk = resolveWith({ [PATHS.claudeSettings]: JSON.stringify({ permissions: { defaultMode: "dontAsk" } }) }, {});
  return expect(dontAsk.permissionMode.value === "default" && dontAsk.permissionMode.source === "builtin", "dontAsk skipped");
});

test("B3: request queuing follows chat.requestQueuing.defaultAction, builtin is queue", () => {
  expect(resolveWith({}, {}).requestQueuing.value === "queue", "builtin queue");
  const steer = resolveWith({ [vscodeFile]: JSON.stringify({ "chat.requestQueuing.defaultAction": "steer" }) }, {});
  expect(steer.requestQueuing.value === "steer" && steer.requestQueuing.source === "vscode", "steer from vscode");
  const queue = resolveWith({ [vscodeFile]: JSON.stringify({ "chat.requestQueuing.defaultAction": "queue" }) }, {});
  expect(queue.requestQueuing.value === "queue" && queue.requestQueuing.source === "vscode", "queue from vscode");
  return expect(resolveWith({ [vscodeFile]: JSON.stringify({ "chat.requestQueuing.defaultAction": "later" }) }, {}).requestQueuing.source === "builtin", "unknown ignored");
});

test("Request queuing: Lodestar setting > VS Code > builtin queue; null follows VS Code", () => {
  const vscodeSteer = { [vscodeFile]: JSON.stringify({ "chat.requestQueuing.defaultAction": "steer" }) };
  const vscodeQueue = { [vscodeFile]: JSON.stringify({ "chat.requestQueuing.defaultAction": "queue" }) };
  const chosen = (requestQueuing: Chosen["requestQueuing"]): Chosen => ({ ...NONE, requestQueuing });
  const follow = resolveWith(vscodeSteer, {}, chosen(null));
  expect(follow.requestQueuing.value === "steer" && follow.requestQueuing.source === "vscode", "null follows VS Code steer");
  const queueWins = resolveWith(vscodeSteer, {}, chosen("queue"));
  expect(queueWins.requestQueuing.value === "queue" && queueWins.requestQueuing.source === "agent-nav", "chosen queue beats VS Code steer");
  const steerWins = resolveWith(vscodeQueue, {}, chosen("steer"));
  expect(steerWins.requestQueuing.value === "steer" && steerWins.requestQueuing.source === "agent-nav", "chosen steer beats VS Code queue");
  const alone = resolveWith({}, {}, chosen("steer"));
  expect(alone.requestQueuing.value === "steer" && alone.requestQueuing.source === "agent-nav", "chosen steer without VS Code");
  const builtin = resolveWith({}, {}, chosen(null));
  expect(builtin.requestQueuing.value === "queue" && builtin.requestQueuing.source === "builtin", "nothing anywhere is queue");
  const bad = resolveWith(vscodeSteer, {}, chosen("later" as never));
  return expect(bad.requestQueuing.value === "steer" && bad.requestQueuing.source === "vscode", "an invalid stored value falls through to VS Code");
});

test("~/.claude permissions.defaultMode acceptEdits is used when VS Code has no permission setting", () => {
  const r = resolveWith({ [PATHS.claudeSettings]: JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }) }, {});
  return expect(r.permissionMode.value === "acceptEdits" && r.permissionMode.source === "claude", "acceptEdits");
});

test("Nothing anywhere: builtin values and null model/effort", () => {
  const r = resolveWith({}, {});
  expect(r.model.value === null && r.model.source === "builtin", "model null");
  expect(r.effort.value === null && r.effort.source === "builtin", "effort null");
  expect(r.diffInlineWhenNarrow.value === true && r.diffInlineWhenNarrow.source === "builtin", "diff switch on");
  return expect(r.sessionSort.value === "updated" && r.permissionMode.value === "default", describeDefaults(r));
});

test("bypassPermissions in VS Code needs allowDangerouslySkipPermissions", () => {
  const settings = JSON.stringify({ "claudeCode.initialPermissionMode": "bypassPermissions" });
  const r = resolveWith({ [vscodeFile]: settings }, {});
  expect(r.permissionMode.value === "default" && r.permissionMode.source === "builtin", "refused without the flag");
  const ok = resolveWith({ [vscodeFile]: JSON.stringify({ "claudeCode.initialPermissionMode": "plan" }) }, {});
  return expect(ok.permissionMode.value === "plan", "plan needs no flag");
});

test("Broken files and broken state values do not throw", () => {
  const r = resolveWith({ [vscodeFile]: "{ not json", [PATHS.claudeSettings]: "[1,2" }, { [MODEL_KEY]: "garbage", [CONFIG_KEY]: "{broken" });
  return expect(r.model.source === "builtin" && r.effort.source === "builtin" && r.permissionMode.source === "builtin", "all builtin");
});

test("A model 'default' in ~/.claude or the chosen settings means no choice", () => {
  const r = resolveWith({ [PATHS.claudeSettings]: JSON.stringify({ model: "default" }) }, {}, { ...NONE, defaultModel: "default" });
  return expect(r.model.source === "builtin", "default is not a model");
});

test("Reader caches VS Code reads for a few seconds, then reads again; chosen values apply immediately", () => {
  let reads = 0;
  let clock = 1000;
  const io: Io = { readText: () => null, vscodeState: () => (reads++, null) };
  const reader = new DefaultsReader(PATHS, io, () => clock);
  reader.resolve(NONE);
  reader.resolve(NONE);
  expect(reads === 2, `one read pass (sort key + model key) inside the window (${reads})`);
  expect(reader.resolve({ ...NONE, defaultEffort: "low" }).effort.source === "agent-nav", "chosen value not cached");
  clock += 6000;
  reader.resolve(NONE);
  reader.resolve(NONE, true);
  return expect(reads === 6, `window expired + forced = three passes (${reads})`);
});

test("Path overrides come from env, otherwise the real locations", () => {
  const injected = defaultPaths({ AGENT_NAV_VSCODE_USER_DIR: "/x/User", AGENT_NAV_CLAUDE_SETTINGS: "/x/claude.json" });
  const real = defaultPaths({});
  expect(injected.vscodeUserDir === "/x/User" && injected.claudeSettings === "/x/claude.json", "env");
  return expect(real.vscodeUserDir.endsWith("Library/Application Support/Code/User") && real.claudeSettings.endsWith(".claude/settings.json"), "real");
});

test("A real sqlite file is read read-only and a missing one is skipped", () => {
  const dir = join(home, "vscode-user");
  mkdirSync(join(dir, "globalStorage"), { recursive: true });
  const db = join(dir, "globalStorage", "state.vscdb");
  if (!existsSync("/usr/bin/sqlite3")) return "skipped (no sqlite3)";
  const sql = `create table ItemTable (key text unique on conflict replace, value blob); insert into ItemTable values ('agentSessions.sorting', 'created'), ('${MODEL_KEY}', '${SONNET}'), ('${CONFIG_KEY}', '{"${SONNET}":{"thinkingLevel":"medium"}}');`;
  execFileSync("/usr/bin/sqlite3", [db, sql]);
  writeFileSync(join(dir, "settings.json"), VSCODE_SETTINGS);
  const paths = { vscodeUserDir: dir, claudeSettings: join(home, "none.json") };
  const r = resolveFrom(NONE, readVscode(fileIo(paths), paths), readClaude(fileIo(paths), paths));
  expect(r.model.value === "sonnet" && r.effort.value === "medium" && r.effort.source === "vscode", "read from sqlite");
  expect(r.sessionSort.value === "created", "sort read from sqlite");
  expect(!existsSync(`${db}-wal`) && !existsSync(`${db}-journal`), "no side files left behind");
  const missing = { vscodeUserDir: join(home, "nowhere"), claudeSettings: join(home, "none.json") };
  const none = resolveFrom(NONE, readVscode(fileIo(missing), missing), readClaude(fileIo(missing), missing));
  return expect(none.model.source === "builtin", "missing file skipped");
});

test("Migration: old built-in values become 'not chosen', other values stay chosen", () => {
  const old = migrateSettings({ theme: "dark", defaultPermissionMode: "default", defaultModel: null, defaultEffort: null, quickModel: "haiku" } as never);
  expect(old.migrated && old.settings.settingsVersion === 2, "migrated");
  expect(old.settings.defaultPermissionMode === null && old.settings.defaultModel === null && old.settings.defaultEffort === null, "all null");
  expect(old.settings.quickModel === "haiku", "other fields kept");
  const chosen = migrateSettings({ defaultPermissionMode: "acceptEdits", defaultModel: "opus", defaultEffort: "high" } as never);
  expect(chosen.settings.defaultPermissionMode === "acceptEdits" && chosen.settings.defaultModel === "opus" && chosen.settings.defaultEffort === "high", "chosen kept");
  const current = migrateSettings({ settingsVersion: 2, defaultPermissionMode: "default" } as never);
  return expect(!current.migrated && current.settings.defaultPermissionMode === "default", "v2 untouched (default is a real choice there)");
});

test("Store: an old settings.json is migrated once and written back as version 2", () => {
  const navHome = process.env.AGENT_NAV_HOME as string;
  writeFileSync(join(navHome, "settings.json"), JSON.stringify({ theme: "dark", defaultPermissionMode: "default", defaultModel: null, defaultEffort: null, quickModel: "haiku", feedbackModel: "sonnet" }));
  const store = new Store();
  expect(store.settings.settingsVersion === 2 && store.settings.defaultPermissionMode === null && store.settings.diffInlineWhenNarrow === null, "in memory");
  const onDisk = JSON.parse(readFileSync(join(navHome, "settings.json"), "utf8"));
  expect(onDisk.settingsVersion === 2 && onDisk.defaultPermissionMode === null, "on disk");
  store.updateSettings({ defaultPermissionMode: "default" });
  const again = new Store();
  return expect(again.settings.defaultPermissionMode === "default", "an explicit 'default' choice survives a restart");
});

test("Store: settings.set validates the four defaults; 'default' model means not chosen; version is not patchable", () => {
  const store = new Store();
  store.updateSettings({ defaultPermissionMode: "nope" as never, defaultEffort: "turbo" as never, defaultModel: "default", diffInlineWhenNarrow: "yes" as never, settingsVersion: 99 });
  expect(store.settings.defaultPermissionMode === "default", "bad permission ignored (kept previous)");
  expect(store.settings.defaultEffort === null && store.settings.defaultModel === null, "bad effort ignored, default model cleared");
  expect(store.settings.diffInlineWhenNarrow === null && store.settings.settingsVersion === 2, "bad diff flag ignored, version fixed");
  store.updateSettings({ defaultEffort: "high", diffInlineWhenNarrow: false });
  expect(store.settings.defaultEffort === "high" && store.settings.diffInlineWhenNarrow === false, "valid values stored");
  store.updateSettings({ defaultEffort: null, diffInlineWhenNarrow: null });
  return expect(store.settings.defaultEffort === null && store.settings.diffInlineWhenNarrow === null, "null resets");
});

test("Store: settings.set accepts queue, steer and null for requestQueuing and rejects the rest", () => {
  const store = new Store();
  expect(store.settings.requestQueuing === null, "default is null");
  store.updateSettings({ requestQueuing: "steer" });
  expect(store.settings.requestQueuing === "steer", "steer stored");
  store.updateSettings({ requestQueuing: "later" as never });
  expect(store.settings.requestQueuing === "steer", "unknown string rejected (kept steer)");
  store.updateSettings({ requestQueuing: 1 as never });
  expect(store.settings.requestQueuing === "steer", "non-string rejected");
  store.updateSettings({ requestQueuing: "queue" });
  expect(store.settings.requestQueuing === "queue", "queue stored");
  expect(new Store().settings.requestQueuing === "queue", "survives a restart");
  store.updateSettings({ requestQueuing: null });
  return expect(store.settings.requestQueuing === null && new Store().settings.requestQueuing === null, "null resets");
});

test("R4FIX: preview editors follow an explicit workbench.editor.enablePreview, builtin off, Lodestar choice wins", () => {
  expect(resolveWith({}, {}).previewEditors.value === false && resolveWith({}, {}).previewEditors.source === "builtin", "builtin off");
  const explicitOn = resolveWith({ [vscodeFile]: JSON.stringify({ "workbench.editor.enablePreview": true }) }, {});
  expect(explicitOn.previewEditors.value === true && explicitOn.previewEditors.source === "vscode", "explicit true from VS Code turns it on");
  const off = { [vscodeFile]: JSON.stringify({ "workbench.editor.enablePreview": false }) };
  const fromVscode = resolveWith(off, {});
  expect(fromVscode.previewEditors.value === false && fromVscode.previewEditors.source === "vscode", "off from VS Code");
  expect(resolveWith({ [vscodeFile]: JSON.stringify({ "workbench.editor.enablePreview": "no" }) }, {}).previewEditors.source === "builtin", "non-boolean ignored");
  const chosenOn = resolveWith(off, {}, { ...NONE, previewEditors: true });
  expect(chosenOn.previewEditors.value === true && chosenOn.previewEditors.source === "agent-nav", "chosen on beats VS Code off");
  const store = new Store();
  store.updateSettings({ previewEditors: "yes" as never });
  expect(store.settings.previewEditors === null, "non-boolean rejected");
  store.updateSettings({ previewEditors: false });
  expect(store.settings.previewEditors === false, "false stored");
  store.updateSettings({ previewEditors: null });
  return expect(store.settings.previewEditors === null, "null resets");
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
rmSync(home, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
