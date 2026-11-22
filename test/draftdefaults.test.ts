import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-draftdefaults-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const memory = new Map<string, string>();
const fake = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = fake;
g.sessionStorage = fake;
g.window = g;
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.document = { querySelector: () => null, documentElement: { dataset: {}, style: {} }, addEventListener() {}, hasFocus: () => true, visibilityState: "visible" };
g.location = { reload() {}, origin: "http://localhost" };

const { draftDefaults } = await import("../web/defaults");
const { getState, panelKey, rememberPick, forgetPick, setPanelWidth, setState, startDraft } = await import("../web/store");
const { copyItems } = await import("../server/agents");
const gitOps = await import("../server/git");
type ResolvedDefaults = import("../shared/protocol").ResolvedDefaults;
type TimelineItem = import("../shared/protocol").TimelineItem;

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const resolved = {
  model: { value: "sonnet", source: "vscode" },
  effort: { value: "medium", source: "vscode" },
  permissionMode: { value: "bypassPermissions", source: "vscode" },
  diffInlineWhenNarrow: { value: false, source: "vscode" },
  sessionSort: { value: "created", source: "vscode" },
  requestQueuing: { value: "queue", source: "vscode" },
  previewEditors: { value: true, source: "builtin" },
} as unknown as ResolvedDefaults;

test("draftDefaults: 고른 적이 없으면 설정 기본값(VS Code), 골랐으면 마지막으로 고른 값이 먼저이고 권한은 따로 고른 적이 없으면 설정값이다(권한 선택 순서는 permission.test.ts)", () => {
  const none = draftDefaults(null, resolved, {});
  expect(none.model === "sonnet" && none.modelSource === "vscode", "no pick: from VS Code");
  expect(none.effort === "medium" && none.effortSource === "vscode", "no pick effort");
  const picked = draftDefaults(null, resolved, { model: "haiku", effort: "low" });
  expect(picked.model === "haiku" && picked.modelSource === "last", "picked model");
  expect(picked.effort === "low" && picked.effortSource === "last", "picked effort");
  expect(picked.permissionMode === "bypassPermissions", "permission was not picked, so it keeps the setting");
  const onlyModel = draftDefaults(null, resolved, { model: "opus" });
  expect(onlyModel.effort === "medium" && onlyModel.effortSource === "vscode", "effort not picked stays default");
  const defaultPick = draftDefaults(null, resolved, { model: null });
  return expect(defaultPick.model === null && defaultPick.modelSource === "last", "picking Default (null) is remembered as a pick");
});

test("rememberPick 과 forgetPick: 저장하고 되돌린다", () => {
  rememberPick({ model: "haiku" });
  rememberPick({ effort: "low" });
  expect(getState().lastPicked.model === "haiku" && getState().lastPicked.effort === "low", "stored in state");
  expect(JSON.parse(memory.get("agent-nav:lastPicked") ?? "{}").model === "haiku", "persisted");
  forgetPick("model");
  expect(!("model" in getState().lastPicked) && getState().lastPicked.effort === "low", "forgot model only");
  return "ok";
});

test("오른쪽 패널 폭은 세션마다 이 실행 동안만 기억하고 저장하지 않는다", () => {
  const pane = { id: "pane-a", kind: "agent" as const, agentId: "s1" };
  const draft = { id: "pane-b", kind: "draft" as const, workspaceId: "w" };
  expect(panelKey({ panes: [pane, draft], activePaneId: "pane-a" }) === "agent:s1", "agent key");
  expect(panelKey({ panes: [pane, draft], activePaneId: "pane-b" }) === "draft:pane-b", "draft key");
  const activeKey = panelKey(getState());
  setPanelWidth(580);
  expect(getState().panelWidths[activeKey] === 580, "stored for the active pane");
  const layout = JSON.parse(memory.get("agent-nav:layout") ?? "{}") as Record<string, unknown>;
  expect(!("rightWidth" in layout), "not persisted with the layout");
  setPanelWidth(null);
  return expect(!(activeKey in getState().panelWidths), "reset removes it");
});

test("copyItems: 갈래의 승인 항목이 새 id 의 도구 호출을 가리킨다", () => {
  const items = [
    { id: "tool1", kind: "tool", name: "Write", input: {}, status: "done", output: "" },
    { id: "perm1", kind: "permission", toolUseId: "tool1", toolName: "Write", input: {}, status: "allowed" },
  ] as unknown as TimelineItem[];
  const copied = copyItems(items, "abcdef0123456789");
  const [tool, permission] = copied;
  return expect(permission.kind === "permission" && permission.toolUseId === tool.id, `permission ${JSON.stringify(permission)} tool ${tool.id}`);
});

test("git.branches 는 커밋하지 않은 파일 수를 센다", async () => {
  const repo = join(home, "repo");
  mkdirSync(repo);
  const run = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, stdio: "ignore" });
  run("init", "-q");
  writeFileSync(join(repo, "a.txt"), "a\n");
  run("add", "-A");
  run("commit", "-qm", "init");
  expect((await gitOps.branches(repo)).uncommitted === 0, "clean repo");
  writeFileSync(join(repo, "a.txt"), "b\n");
  writeFileSync(join(repo, "c.txt"), "c\n");
  return expect((await gitOps.branches(repo)).uncommitted === 2, "two files");
});

test("Settings 에서 직접 고른 모델과 effort 는 마지막으로 고른 값보다 앞선다 (dogfood 2회차 2번)", () => {
  const explicit = { ...resolved, model: { value: "haiku", source: "agent-nav" }, effort: { value: "low", source: "agent-nav" } } as unknown as ResolvedDefaults;
  const r = draftDefaults(null, explicit, { model: "claude-haiku-4-5-20251001", effort: "high" });
  expect(r.model === "haiku" && r.modelSource === "agent-nav", "explicit model wins over last picked");
  return expect(r.effort === "low" && r.effortSource === "agent-nav", "explicit effort wins over last picked");
});

test("같은 칸에 새 초안이 열리면 이전 초안에서 칩으로 고른 모델, effort, 권한이 남지 않는다 (dogfood 2회차 2번)", () => {
  setState({ draftModel: { "pane-x": "claude-haiku-4-5-20251001", "pane-y": "opus" }, draftEffort: { "pane-x": "high" }, draftPermission: { "pane-x": "plan" }, activePaneId: "pane-x" });
  startDraft("w1");
  const s = getState();
  expect(!("pane-x" in s.draftModel) && !("pane-x" in s.draftEffort) && !("pane-x" in s.draftPermission), "pane-x picks cleared");
  expect(s.draftModel["pane-y"] === "opus", "other panes keep their picks");
  startDraft("w1", "active", { preset: { model: "sonnet", effort: "low", permission: "default" } });
  return expect(getState().draftModel["pane-x"] === "sonnet" && getState().draftEffort["pane-x"] === "low", "preset still seeds the pane");
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${await c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
rmSync(home, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
