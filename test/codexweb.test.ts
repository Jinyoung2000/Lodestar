import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-codexweb-"));
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

const { codexDefaultModel, codexLevels, codexModelChip, codexModelInfos, paneHarness } = await import("../web/harness");
const { getState, rememberPick, setState, startDraft } = await import("../web/store");
const { carryLevel, choiceRows, claudeModels, landingKey, pickerRows, pinKey, rowKey, stepTab, toolModels } = await import("../web/modelChoices");
type CodexMeta = import("../shared/protocol").CodexMeta;
type Agent = import("../shared/protocol").Agent;

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const meta: CodexMeta = {
  installed: true,
  version: "0.163.0",
  loggedIn: true,
  account: { type: "chatgpt", plan: "plus" },
  models: [
    { value: "gpt-a", displayName: "GPT A", description: "", isDefault: true, supportedEffortLevels: ["low", "medium", "high"], defaultEffort: "medium" },
    { value: "gpt-b", displayName: "GPT B", description: "", isDefault: false, supportedEffortLevels: ["low"], defaultEffort: "low" },
  ],
  defaultModel: "gpt-config-only",
  defaultEffort: "high",
  error: null,
  fetchedAt: "",
};
const agent = (id: string, harness?: "codex"): Agent => ({ id, workspaceId: null, cwd: "/x", worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: "t", sessionId: null, status: "idle", permissionMode: "default", model: null, effort: null, activeModel: null, activeEffort: null, backgroundTasks: 0, createdAt: "", updatedAt: "", ...(harness ? { harness } : {}) });

test("세션 칸은 세션의 도구, 새 세션 칸은 그 칸에서 고른 도구, 없으면 마지막 선택, 그것도 없으면 claude", () => {
  const s = { agents: [agent("a"), agent("b", "codex")], draftHarness: { d1: "codex" as const }, lastPicked: {} };
  expect(paneHarness(s, { id: "p1", kind: "agent", agentId: "a" }) === "claude", "harness 필드가 없는 옛 세션은 claude");
  expect(paneHarness(s, { id: "p2", kind: "agent", agentId: "b" }) === "codex", "codex 세션");
  expect(paneHarness(s, { id: "d1", kind: "draft", workspaceId: null }) === "codex", "칸에서 고른 값");
  expect(paneHarness(s, { id: "d2", kind: "draft", workspaceId: null }) === "claude", "기본은 claude");
  expect(paneHarness({ ...s, lastPicked: { harness: "codex" } }, { id: "d2", kind: "draft", workspaceId: null }) === "codex", "마지막 선택을 이어받는다");
  return "ok";
});

test("모델 칩: 고르지 않은 Codex 세션은 config.toml 의 모델을 보이고, 목록에 없는 id 도 그대로 보인다", () => {
  expect(codexModelChip(null, null, meta).name === "gpt-config-only", "config 모델은 목록에 없어도 id 그대로");
  expect(codexModelChip(null, "gpt-a", meta).name === "GPT A", "실제로 쓰인 모델이 있으면 그 이름");
  expect(codexModelChip("gpt-b", "gpt-a", meta).name === "GPT B", "새로 고른 모델이 앞선다");
  expect(codexModelChip(null, null, null).name === "Codex", "정보가 없으면 Codex");
  expect(codexDefaultModel({ ...meta, defaultModel: null }) === "gpt-a", "config 가 없으면 목록의 기본 모델");
  return "ok";
});

test("effort 단계: 고른 모델이 지원하는 것만, 고르지 않았으면 기본 모델의 것", () => {
  expect(codexLevels(meta, "gpt-a").join() === "low,medium,high", "gpt-a");
  expect(codexLevels(meta, "gpt-b").join() === "low", "gpt-b");
  expect(codexLevels(meta, null).join() === "low,medium,high", "config 모델이 목록에 없으면 기본 모델의 단계");
  expect(codexLevels(null, null).length === 0, "정보가 없으면 빈 목록");
  return "ok";
});

test("Codex 모델은 Claude 팝업이 읽는 ModelInfo 모양으로 맞춘다", () => {
  const infos = codexModelInfos(meta);
  expect(infos[0].value === "gpt-a" && infos[0].resolvedModel === "gpt-a" && infos[0].displayName === "GPT A" && infos[0].supportedEffortLevels.length === 3, JSON.stringify(infos[0]));
  expect(codexModelInfos(null).length === 0, "정보가 없으면 빈 목록");
  return "ok";
});

test("마지막 선택: harness 와 Codex 모델은 Claude 의 모델 선택과 따로 기억된다", () => {
  rememberPick({ model: "claude-x", effort: "low" });
  rememberPick({ harness: "codex", codexModel: "gpt-a", codexEffort: "high" });
  const saved = JSON.parse(memory.get("agent-nav:lastPicked") ?? "{}");
  expect(saved.model === "claude-x" && saved.codexModel === "gpt-a" && saved.harness === "codex" && saved.codexEffort === "high", JSON.stringify(saved));
  expect(getState().lastPicked.model === "claude-x", "Claude 선택은 그대로");
  return "ok";
});

test("새 세션 화면을 다시 열면 그 칸의 도구 선택은 지워지고 마지막 선택에서 시작한다", () => {
  const pane = startDraft(null, "new");
  setState((s) => ({ draftHarness: { ...s.draftHarness, [pane]: "claude" } }));
  expect(getState().draftHarness[pane] === "claude", "칸에서 고름");
  const again = startDraft(null, "active");
  expect(again === pane && !(pane in getState().draftHarness), "같은 칸에 새 초안이 열리면 고른 도구가 지워진다");
  return "ok";
});

test("model popover rows: provider tab, search across providers with headers, pinned, status, custom name", () => {
  const providers = [
    { tool: "claude" as const, models: claudeModels([{ value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportedEffortLevels: [] }], "opus"), status: null },
    { tool: "codex" as const, models: toolModels("codex", meta), status: null },
    { tool: "antigravity" as const, models: [], status: "Antigravity CLI was not found." },
  ];
  const names = (rows: ReturnType<typeof pickerRows>) => rows.map((r) => (r.kind === "header" ? `#${r.tool}` : r.kind === "status" ? `!${r.text}` : r.kind === "model" ? r.model.value : `+${r.value}`)).join(",");
  expect(names(pickerRows(providers, "codex", "", [], "codex")) === "#codex,gpt-a,gpt-b", names(pickerRows(providers, "codex", "", [], "codex")));
  expect(names(pickerRows(providers, "antigravity", "", [], "antigravity")) === "#antigravity,!Antigravity CLI was not found.", "missing provider shows its status");
  expect(names(pickerRows(providers, "codex", "opus", [], "codex")) === "#claude,opus", "search finds models of other providers too");
  expect(names(pickerRows(providers, "claude", "a", [], "claude")) === "#codex,gpt-a,#claude,+a", names(pickerRows(providers, "claude", "a", [], "claude")));
  expect(names(pickerRows(providers, "pinned", "", [pinKey("codex", "gpt-b"), "opus"], "claude")) === "#claude,opus,#codex,gpt-b", "pinned grouped by provider");
  expect(names(pickerRows(providers, "pinned", "", [], "claude")) === "", "nothing pinned");
  const claude = providers[0].models[0];
  expect(claude.isDefault && claude.levels.join() === "low,medium,high,xhigh,max" && claude.defaultLevel === "high", JSON.stringify(claude));
  const codex = toolModels("codex", meta);
  expect(codex[0].defaultLevel === "medium" && !codex.some((m) => m.isDefault), "default comes from config.toml even when it is not listed");
  const rows = choiceRows(pickerRows(providers, "claude", "", [], "claude"));
  expect(landingKey(rows, [["claude", "claude-opus-5-5"]]) === rowKey(rows[0]), "resolved id lands on its row");
  expect(carryLevel("high", ["low", "medium", "high"], "medium") === "high" && carryLevel("max", ["low"], "low") === "low" && carryLevel("high", [], "high") === null, "level carry");
  return expect(stepTab("pinned", -1) === "cursor" && stepTab("cursor", 1) === "pinned" && stepTab("antigravity", 1) === "cursor" && stepTab("claude", 1) === "codex", "tab cycle");
});

let failed = 0;
for (const c of cases) {
  try {
    c.run();
    console.log(`ok   ${c.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
