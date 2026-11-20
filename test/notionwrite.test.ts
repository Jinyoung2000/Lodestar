// Notion 쓰기 경로의 승인 보장을 확인한다: 도구 분류(읽기 목록에 없으면 쓰기), 제안 인자 거르기, 미리보기, gatedWrite, 제안 도구 핸들러, 데몬의 승인 카드 흐름.
// 승인 없이는 MCP 쓰기 호출(host.write)이 나가지 않는다는 것이 핵심이고, 모델과 Notion 은 부르지 않는다. 실행: npm test
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-notionwrite-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });

const { allToolsExcept, classifyTool, isBlockedNotionWrite, isNotionProposeTool, notionDisallowedTools, OWN_PREFIX } = await import("../shared/notionMcp");
const { applyUpdates, cleanCreateArgs, cleanUpdateArgs, previewCreate, previewUpdate, rejectionMessage } = await import("../shared/notionWrite");
const { notionWriteGuard } = await import("../server/notionGuard");
const { notionWriteGate } = await import("../shared/notionApproval");
const { gatedWrite, writeResultText } = await import("../server/notionWrite");
const { runCreate, runUpdate } = await import("../server/notionTools");
const { AgentRunner } = await import("../server/agents");
const { Store } = await import("../server/store");
const { needsReview, pendingToolRequest } = await import("../shared/interactive");
type NotionToolHost = import("../server/notionTools").NotionToolHost;
type NotionPageData = import("../shared/notionFetch").NotionPageData;
type ServerEvent = import("../shared/protocol").ServerEvent;

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const same = (actual: unknown, wanted: unknown) => expect(JSON.stringify(actual) === JSON.stringify(wanted), `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);

const ID = "aaaaaaaabbbbccccddddeeeeeeeeeeee";
const page = (enhanced: string, properties: Record<string, unknown> = {}): NotionPageData => ({ kind: "page", id: ID, title: "Weekly Plan", url: `https://www.notion.so/${ID}`, icon: null, path: null, lastEditedAt: null, markdown: enhanced, enhanced, properties, truncated: false, needsBrowser: false });

test("분류: 읽기 목록의 도구는 read, 나머지 Notion 도구는 모두 write (새 도구도 막힌다)", () => {
  same(
    ["mcp__notion__notion-fetch", "mcp__notion__notion-search", "mcp__notion__notion-query-data-sources", "mcp__notion__notion-get-users"].map(classifyTool),
    ["read", "read", "read", "read"],
  );
  same(
    ["mcp__notion__notion-update-page", "mcp__notion__notion-create-pages", "mcp__notion__notion-delete-pages", "mcp__notion__notion-create-comment", "mcp__notion__notion-move-pages", "mcp__notion__notion-frobnicate-new-tool"].map(classifyTool),
    ["write", "write", "write", "write", "write", "write"],
  );
});

test("분류: 서버 이름이 달라도(claude.ai 커넥터, uuid 이름) 도구 이름으로 쓰기를 알아본다", () => {
  expect(isBlockedNotionWrite("mcp__claude_ai_Notion__notion-update-page"), "claude.ai");
  expect(isBlockedNotionWrite("mcp__01234567-89ab-4cde-8f01-23456789abcd__notion-create-pages"), "uuid server");
  expect(isBlockedNotionWrite("mcp__my-notion-proxy__update_page"), "서버 이름에 notion");
  expect(!isBlockedNotionWrite("mcp__claude_ai_Notion__notion-fetch"), "읽기");
  expect(classifyTool("mcp__slack__slack_send_message") === "other" && classifyTool("Bash") === "other" && classifyTool("mcp__browser__read_page") === "other", "Notion 이 아니면 상관없음");
});

test("분류: 우리 제안 서버는 own 이고 막히지 않는다 (이름에 notion 이 들어 있어도)", () => {
  const update = `${OWN_PREFIX}notion_update_page`;
  expect(classifyTool(update) === "own" && !isBlockedNotionWrite(update) && isNotionProposeTool(update), "own");
  expect(isNotionProposeTool(`${OWN_PREFIX}notion_create_pages`) && !isNotionProposeTool(`${OWN_PREFIX}board_add_cards`), "propose 는 둘뿐");
  expect(needsReview(update) && needsReview("AskUserQuestion") && !needsReview("Bash"), "승인 단축키와 사이드바 허용에서 빠진다");
  expect(pendingToolRequest([{ id: "1", kind: "permission", toolName: update, status: "pending" }]) === null, "⌘Enter 허용 대상이 아니다");
});

test("도구 목록에서 빼는 이름: 알려진 쓰기 도구는 전부, 읽기는 하나도 없다", () => {
  const names = notionDisallowedTools();
  expect(names.includes("mcp__notion__notion-update-page") && names.includes("mcp__claude_ai_Notion__notion-create-pages") && names.includes("mcp__notion__notion-delete-pages"), "쓰기");
  expect(names.every((n) => classifyTool(n) === "write"), "전부 write 로 분류된다");
  const others = allToolsExcept("notion", "notion-fetch");
  expect(!others.includes("mcp__notion__notion-fetch") && others.includes("mcp__notion__notion-update-page") && others.includes("mcp__notion__notion-search"), "하나만 남긴다");
});

test("PreToolUse 훅 판정: Notion 쓰기는 deny, 읽기와 우리 제안 도구와 다른 도구는 통과, 이상한 입력도 쓰기를 통과시키지 않는다", () => {
  const hook = (tool_name: unknown, hook_event_name = "PreToolUse") => notionWriteGuard({ hook_event_name, tool_name });
  const denied = (o: ReturnType<typeof hook>) => "hookSpecificOutput" in o && o.hookSpecificOutput.permissionDecision === "deny";
  expect(denied(hook("mcp__notion__notion-update-page")) && denied(hook("mcp__notion__notion-archive-workspace")) && denied(hook("mcp__claude_ai_Notion__notion-delete-pages")), "쓰기 deny");
  expect(JSON.stringify(hook("mcp__notion__notion-fetch")) === "{}" && JSON.stringify(hook(`${OWN_PREFIX}notion_update_page`)) === "{}" && JSON.stringify(hook("Bash")) === "{}" && JSON.stringify(hook("mcp__slack__slack_send_message")) === "{}", "그 밖은 통과");
  const reason = (hook("mcp__notion__notion-create-pages") as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;
  expect(reason.includes("notion_update_page") && reason.includes("approves"), "제안 도구로 안내");
});

test("update 인자 거르기: 모르는 필드와 allow_deleting_content 는 버린다 (카드에 안 보인 것이 새지 않게)", () => {
  const r = cleanUpdateArgs({ page_id: ID, command: "update_content", content_updates: [{ old_str: "a", new_str: "b", extra: 1 }], allow_deleting_content: true, template_id: "x", is_skill: true, verification_status: "verified", cover: "http://x" });
  expect(r.ok, "ok");
  if (r.ok) same(r.args, { page_id: ID, command: "update_content", content_updates: [{ old_str: "a", new_str: "b" }] });
});

test("update 인자 거르기: 명령마다 필수 값, 잘못된 모양은 이유와 함께 거절", () => {
  const bad = (raw: unknown) => {
    const r = cleanUpdateArgs(raw);
    expect(!r.ok, `거절돼야 함 ${JSON.stringify(raw)}`);
  };
  bad(null);
  bad({ command: "update_content" });
  bad({ page_id: ID, command: "apply_template", template_id: "t" });
  bad({ page_id: ID, command: "update_verification", verification_status: "verified" });
  bad({ page_id: ID, command: "update_content", content_updates: [] });
  bad({ page_id: ID, command: "update_content", content_updates: [{ old_str: "", new_str: "x" }] });
  bad({ page_id: ID, command: "replace_content" });
  bad({ page_id: ID, command: "insert_content", content: "" });
  bad({ page_id: ID, command: "update_properties", properties: {} });
  bad({ page_id: ID, command: "update_properties", properties: { a: { nested: 1 } } });
});

test("create 인자 거르기: 부모나 draft 중 하나, 둘 다는 안 됨, 모르는 필드는 버림", () => {
  const ok = cleanCreateArgs({ pages: [{ properties: { title: "Notes" }, content: "hi", secret: 1 }], parent: { type: "page_id", page_id: ID }, template_id: "x" });
  expect(ok.ok, "ok");
  if (ok.ok) same(ok.args, { pages: [{ properties: { title: "Notes" }, content: "hi" }], parent: { type: "page_id", page_id: ID } });
  expect(!cleanCreateArgs({ pages: [{}] }).ok, "부모도 draft 도 없음");
  expect(!cleanCreateArgs({ pages: [{}], parent: { type: "page_id", page_id: ID }, creation_mode: "draft" }).ok, "둘 다");
  expect(cleanCreateArgs({ pages: [{ properties: { title: "x" } }], creation_mode: "draft" }).ok, "draft");
  expect(!cleanCreateArgs({ pages: [] , creation_mode: "draft" }).ok && !cleanCreateArgs({ pages: Array(21).fill({}), creation_mode: "draft" }).ok, "개수 한도");
});

test("미리보기 update_content: 읽은 페이지에 적용한 전체 전후를 만든다", () => {
  const current = page("## Goals\n- one\n- two");
  const r = previewUpdate({ page_id: ID, command: "update_content", content_updates: [{ old_str: "- two", new_str: "- two\n- three" }] }, current);
  expect(r.ok, "ok");
  if (!r.ok) return;
  same(r.preview.diff, { before: "## Goals\n- one\n- two", after: "## Goals\n- one\n- two\n- three", exact: true });
  same(r.preview.warnings, []);
  expect(r.preview.target?.title === "Weekly Plan", "target");
});

test("미리보기 update_content: 못 찾거나 여러 번 나오면 경고와 함께 바꾸는 조각만 보인다 (거절하지는 않는다)", () => {
  const current = page("a a b");
  const missing = previewUpdate({ page_id: ID, command: "update_content", content_updates: [{ old_str: "zzz", new_str: "y" }] }, current);
  const twice = previewUpdate({ page_id: ID, command: "update_content", content_updates: [{ old_str: "a", new_str: "c" }] }, current);
  const all = previewUpdate({ page_id: ID, command: "update_content", content_updates: [{ old_str: "a", new_str: "c", replace_all_matches: true }] }, current);
  const unread = previewUpdate({ page_id: ID, command: "update_content", content_updates: [{ old_str: "a", new_str: "c" }] }, null);
  expect(missing.ok && missing.preview.warnings.length === 1 && missing.preview.diff?.exact === false && missing.preview.diff.before === "zzz", "못 찾음");
  expect(twice.ok && twice.preview.warnings[0].includes("2 times"), "여러 번");
  expect(all.ok && all.preview.warnings.length === 0 && all.preview.diff?.after === "c c b", "전부 바꾸기");
  expect(unread.ok && unread.preview.warnings.length === 1 && unread.preview.target === null, "페이지를 못 읽음");
});

test("applyUpdates: 차례로 적용한다 (앞 변경의 결과에 뒤 변경이 걸린다)", () => {
  const r = applyUpdates("one two", [{ old_str: "one", new_str: "1" }, { old_str: "1 two", new_str: "done" }]);
  expect(r.ok && r.text === "done", JSON.stringify(r));
});

test("미리보기 replace/insert: 전체 교체는 절반 미만으로 줄면 경고, insert 는 처음이나 끝에 붙인다", () => {
  const current = page("x".repeat(100));
  const shrink = previewUpdate({ page_id: ID, command: "replace_content", new_str: "short" }, current);
  expect(shrink.ok && shrink.preview.warnings.length === 1, "줄어듦 경고");
  const end = previewUpdate({ page_id: ID, command: "insert_content", content: "Z" }, page("A"));
  const start = previewUpdate({ page_id: ID, command: "insert_content", content: "Z", position: { type: "start" } }, page("A"));
  expect(end.ok && end.preview.diff?.after === "A\nZ" && start.ok && start.preview.diff?.after === "Z\nA", "insert");
});

test("미리보기 속성: 현재 값과 새 값을 나란히", () => {
  const r = previewUpdate({ page_id: ID, command: "update_properties", properties: { Status: "Done", Owner: null, title: "New" } }, page("x", { Status: "Todo", Owner: "Alex" }));
  expect(r.ok, "ok");
  if (r.ok) same(r.preview.properties, [{ name: "Status", before: "Todo", after: "Done" }, { name: "Owner", before: "Alex", after: null }, { name: "title", before: "Weekly Plan", after: "New" }]);
});

test("미리보기 create: 행 하나는 속성 표, 부모 제목, 본문은 빈 글에서 시작하는 diff", () => {
  const r = previewCreate({ pages: [{ properties: { Name: "Row", Status: "New" }, content: "Notes" }], parent: { type: "data_source_id", data_source_id: ID } }, null);
  expect(r.ok, "ok");
  if (!r.ok) return;
  expect(r.preview.summary === "Add a row" && r.preview.kind === "create", r.preview.summary);
  same(r.preview.properties, [{ name: "Name", before: null, after: "Row" }, { name: "Status", before: null, after: "New" }]);
  same(r.preview.diff, { before: "", after: "Notes", exact: true });
  const many = previewCreate({ pages: [{ properties: { title: "A" } }, { properties: { title: "B" } }], creation_mode: "draft" }, null);
  expect(many.ok && many.preview.creates?.length === 2 && many.preview.summary === "Create 2 pages", "여러 페이지");
});

test("rejectionMessage: 사용자가 쓴 이유가 있으면 그대로 싣고 재시도하지 말라고 알린다", () => {
  expect(rejectionMessage().includes("nothing was sent") && !rejectionMessage().includes("note"), "기본");
  expect(rejectionMessage(" drop the second bullet ").includes("drop the second bullet"), "이유");
});

// ---- gatedWrite: 승인 없이는 run 이 불리지 않는다 ----

const writeOk = async (..._args: unknown[]) => ({ sent: true, text: '{"updated":true}', isError: false, costUsd: 0.001 });

test("gatedWrite: 거절하면 run 이 불리지 않는다", async () => {
  let ran = 0;
  const out = await gatedWrite({ tool: "notion-update-page", args: { a: 1 }, ask: async () => ({ allowed: false, feedback: "no" }), run: async (...a) => (ran++, writeOk(...a)) });
  expect(ran === 0 && !out.sent && out.text.includes("no"), `ran=${ran}`);
});

test("gatedWrite: ask 가 예외를 던져도(세션 닫힘 등) run 은 불리지 않는다", async () => {
  let ran = 0;
  const out = await gatedWrite({ tool: "notion-create-pages", args: {}, ask: async () => Promise.reject(new Error("closed")), run: async (...a) => (ran++, writeOk(...a)) });
  expect(ran === 0 && !out.sent && out.reason === "ask-failed", "ask-failed");
});

test("gatedWrite: allowed 가 정확히 true 일 때만 나간다 (truthy 값, 빈 객체는 거절)", async () => {
  let ran = 0;
  for (const answer of [{} as never, { allowed: "yes" } as never, { allowed: 1 } as never, undefined as never, null as never]) {
    await gatedWrite({ tool: "notion-update-page", args: {}, ask: async () => answer, run: async (...a) => (ran++, writeOk(...a)) }).catch(() => undefined);
  }
  expect(ran === 0, `ran=${ran}`);
});

test("gatedWrite: 아직 답이 없으면(끝나지 않는 ask) run 도 시작하지 않는다", async () => {
  let ran = 0;
  const pending = gatedWrite({ tool: "notion-update-page", args: {}, ask: () => new Promise(() => undefined), run: async (...a) => (ran++, writeOk(...a)) });
  const winner = await Promise.race([pending.then(() => "done"), new Promise((r) => setTimeout(() => r("waiting"), 50))]);
  expect(winner === "waiting" && ran === 0, "승인을 기다리는 동안 쓰기 없음");
});

test("gatedWrite: 승인하면 run 이 한 번, 승인 시점 인자의 사본으로 불린다", async () => {
  const args = { page_id: ID, nested: { v: 1 } };
  const seen: unknown[] = [];
  const out = await gatedWrite({
    tool: "notion-update-page",
    args,
    ask: async () => {
      args.nested.v = 2; // 묻는 동안 원본이 바뀌어도
      return { allowed: true };
    },
    run: async (tool, given) => (seen.push({ tool, given }), writeOk()),
  });
  expect(out.sent && seen.length === 1, "한 번");
  same(seen[0], { tool: "notion-update-page", given: { page_id: ID, nested: { v: 1 } } });
});

test("writeResultText: 적용됨, Notion 거절, 승인 거절을 모델이 구분할 수 있다", () => {
  expect(writeResultText({ sent: true, text: "ok", isError: false, costUsd: 0 }).startsWith("Applied to Notion"), "applied");
  expect(writeResultText({ sent: true, text: "bad", isError: true, costUsd: 0 }).startsWith("Notion rejected the change"), "notion error");
  expect(writeResultText({ sent: false, text: rejectionMessage(), reason: "rejected" }).includes("nothing was sent"), "rejected");
});

// ---- 제안 도구 핸들러 ----

function host(overrides: Partial<NotionToolHost> & { current?: NotionPageData | null } = {}) {
  const calls = { ask: [] as { tool: string; summary: string }[], write: [] as { tool: string; args: Record<string, unknown> }[], changed: [] as string[], read: 0 };
  const base: NotionToolHost = {
    read: async () => (calls.read++, overrides.current === undefined ? page("## Goals\n- one") : overrides.current),
    cachedTitle: () => "Team",
    ask: async (tool, _input, preview) => (calls.ask.push({ tool, summary: preview.summary }), { allowed: true }),
    write: async (tool, args) => (calls.write.push({ tool, args }), { sent: true, text: '{"ok":true}', isError: false, costUsd: 0.001 }),
    changed: (ref) => void calls.changed.push(ref),
    page: null,
    addCards: null,
    startSession: null,
  };
  return { host: { ...base, ...overrides } as NotionToolHost, calls };
}

test("update 핸들러: 잘못된 인자는 승인도 쓰기도 없이 오류를 돌려준다", async () => {
  const { host: h, calls } = host();
  const { result } = await runUpdate(h, "t", { page_id: ID, command: "update_content", content_updates: [] });
  expect(result.isError === true && calls.ask.length === 0 && calls.write.length === 0 && calls.read === 0, JSON.stringify(calls));
});

test("update 핸들러: 거절하면 쓰기 호출이 없고, 모델에게 거절 글이 간다", async () => {
  const { host: h, calls } = host({ ask: async () => ({ allowed: false, feedback: "keep the second bullet" }) });
  const { result, outcome } = await runUpdate(h, "t", { page_id: ID, command: "update_content", content_updates: [{ old_str: "- one", new_str: "- uno" }] });
  expect(calls.write.length === 0 && calls.changed.length === 0 && outcome?.sent === false, "쓰기 없음");
  expect(JSON.stringify(result.content).includes("keep the second bullet") && !result.isError, "거절 글");
});

test("update 핸들러: 승인하면 정리된 인자 그대로 한 번 쓰고, 페이지를 다시 읽게 알린다", async () => {
  const { host: h, calls } = host();
  const { result } = await runUpdate(h, "mcp__lodestar_notion__notion_update_page", { page_id: ID, command: "update_content", content_updates: [{ old_str: "- one", new_str: "- uno" }], allow_deleting_content: true });
  expect(calls.ask.length === 1 && calls.ask[0].summary === "Edit page", "카드 한 번");
  expect(calls.write.length === 1 && calls.write[0].tool === "notion-update-page", "쓰기 한 번");
  same(calls.write[0].args, { page_id: ID, command: "update_content", content_updates: [{ old_str: "- one", new_str: "- uno" }] });
  same(calls.changed, [`https://www.notion.so/${ID}`]);
  expect(JSON.stringify(result.content).includes("Applied to Notion"), "결과");
});

test("update 핸들러: 페이지를 못 읽어도 승인 카드는 뜨고, 승인 없이는 쓰지 않는다", async () => {
  const { host: h, calls } = host({ current: null, ask: async () => ({ allowed: false }) });
  await runUpdate(h, "t", { page_id: ID, command: "replace_content", new_str: "all new" });
  expect(calls.write.length === 0, "쓰기 없음");
});

test("update 핸들러: Notion 이 거절하면 오류 결과이고 changed 는 부르지 않는다", async () => {
  const { host: h, calls } = host({ write: async () => ({ sent: true, text: "validation_error", isError: true, costUsd: 0 }) });
  const { result } = await runUpdate(h, "t", { page_id: ID, command: "insert_content", content: "x" });
  expect(result.isError === true && calls.changed.length === 0, "오류");
});

test("create 핸들러: 거절하면 쓰기 없음, 승인하면 정리된 인자로 한 번", async () => {
  const denied = host({ ask: async () => ({ allowed: false }) });
  await runCreate(denied.host, "t", { pages: [{ properties: { title: "Meeting" }, content: "notes" }], creation_mode: "draft" });
  expect(denied.calls.write.length === 0, "거절");
  const accepted = host();
  await runCreate(accepted.host, "t", { pages: [{ properties: { title: "Meeting" }, content: "notes", junk: 1 }], parent: { type: "data_source_id", data_source_id: ID } });
  expect(accepted.calls.write.length === 1 && accepted.calls.write[0].tool === "notion-create-pages", "쓰기");
  same(accepted.calls.write[0].args, { pages: [{ properties: { title: "Meeting" }, content: "notes" }], parent: { type: "data_source_id", data_source_id: ID } });
  const invalid = host();
  const { result } = await runCreate(invalid.host, "t", { pages: [{}] });
  expect(result.isError === true && invalid.calls.ask.length === 0 && invalid.calls.write.length === 0, "부모 없음");
});

// ---- 데몬의 승인 카드 흐름 (가짜 프로세스 없이 askNotionWrite 와 respond 계열) ----

const store = new Store();
const initialBypassWrites = store.settings.notionBypassWrites;
const events: ServerEvent[] = [];
const runner = new AgentRunner(store, (e) => events.push(e));
type Ask = (agentId: string, tool: string, input: Record<string, unknown>, preview: unknown, signal?: AbortSignal) => Promise<{ allowed: boolean; feedback?: string }>;
const askNotion = (agentId: string, tool: string, input: Record<string, unknown>, preview: unknown, signal?: AbortSignal) => (runner as unknown as { askNotionWrite: Ask }).askNotionWrite(agentId, tool, input, preview, signal);
const makeAgent = (id: string, mode: string, extra: Record<string, unknown> = {}) => {
  const now = new Date().toISOString();
  const a = { id, workspaceId: null, cwd: home, worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: "t", sessionId: null, status: "idle", permissionMode: mode, model: null, effort: null, activeModel: null, activeEffort: null, backgroundTasks: 0, createdAt: now, updatedAt: now, ...extra } as unknown as Parameters<typeof store.addAgent>[0];
  store.addAgent(a);
  return a;
};
// 아래 카드 시험은 설정이 "Always ask" 인 Bypass Permissions 세션에서 돈다 (기본값 "apply" 는 NOTION3 시험이 따로 다룬다)
store.updateSettings({ notionBypassWrites: "ask" });
const agent = makeAgent("n-1", "bypassPermissions");
const lastPermission = () => store.timeline(agent.id).filter((i) => i.kind === "permission").at(-1) as Extract<import("../shared/protocol").TimelineItem, { kind: "permission" }>;
const UPDATE_TOOL = `${OWN_PREFIX}notion_update_page`;
const preview = previewUpdate({ page_id: ID, command: "update_content", content_updates: [{ old_str: "- one", new_str: "- uno" }] }, page("- one"));
if (!preview.ok) throw new Error("preview");

test("승인 카드: 설정이 Always ask 면 Bypass Permissions 세션에서도 변경 미리보기와 함께 대기 항목이 생기고, 답이 올 때까지 쓰기가 없다", async () => {
  const { host: h, calls } = host({ ask: (tool, input, p, signal) => askNotion(agent.id, tool, input, p, signal) });
  const running = runUpdate(h, UPDATE_TOOL, { page_id: ID, command: "update_content", content_updates: [{ old_str: "- one", new_str: "- uno" }] });
  await new Promise((r) => setTimeout(r, 30));
  const item = lastPermission();
  expect(item.status === "pending" && item.toolName === UPDATE_TOOL && item.notion?.summary === "Edit page" && item.notion.diff?.after === "## Goals\n- uno", "대기 항목에 미리보기");
  expect(store.agent(agent.id).permissionMode === "bypassPermissions" && calls.write.length === 0, "Bypass 이지만 쓰기 없음");
  runner.respondNotionWrite(agent.id, item.id, true);
  const { result } = await running;
  expect(calls.write.length === 1 && JSON.stringify(result.content).includes("Applied"), "승인 뒤 한 번");
  const done = lastPermission();
  expect(done.status === "allowed" && !!done.notion, "처리한 뒤에도 미리보기가 남는다");
});

test("승인 카드: 거절하면 쓰기가 없고 이유가 모델에 간다", async () => {
  const { host: h, calls } = host({ ask: (tool, input, p, signal) => askNotion(agent.id, tool, input, p, signal) });
  const running = runUpdate(h, UPDATE_TOOL, { page_id: ID, command: "update_content", content_updates: [{ old_str: "- one", new_str: "- uno" }] });
  await new Promise((r) => setTimeout(r, 30));
  runner.respondNotionWrite(agent.id, lastPermission().id, false, "wrong bullet");
  const { result } = await running;
  expect(calls.write.length === 0 && JSON.stringify(result.content).includes("wrong bullet") && lastPermission().status === "denied", "거절");
});

test("승인 카드: 넘기기(X, Esc 의 deny)도 거절이다", async () => {
  const { host: h, calls } = host({ ask: (tool, input, p, signal) => askNotion(agent.id, tool, input, p, signal) });
  const running = runUpdate(h, UPDATE_TOOL, { page_id: ID, command: "insert_content", content: "z" });
  await new Promise((r) => setTimeout(r, 30));
  runner.respondPermission(agent.id, lastPermission().id, "deny");
  await running;
  expect(calls.write.length === 0, "쓰기 없음");
});

test("승인 카드: 허용 단추(allow, allowAlways)로는 답할 수 없다 (diff 를 보지 않은 승인 금지)", async () => {
  const { host: h, calls } = host({ ask: (tool, input, p, signal) => askNotion(agent.id, tool, input, p, signal) });
  const running = runUpdate(h, UPDATE_TOOL, { page_id: ID, command: "insert_content", content: "z" });
  await new Promise((r) => setTimeout(r, 30));
  const id = lastPermission().id;
  for (const decision of ["allow", "allowAlways"] as const) {
    let threw = false;
    try {
      runner.respondPermission(agent.id, id, decision);
    } catch {
      threw = true;
    }
    expect(threw, `${decision} 거절`);
  }
  expect(calls.write.length === 0 && lastPermission().status === "pending", "여전히 대기, 쓰기 없음");
  runner.respondNotionWrite(agent.id, id, false);
  await running;
});

test("승인 카드: 중단(abort)하면 거절이고 쓰기가 없다", async () => {
  const controller = new AbortController();
  const { host: h, calls } = host({ ask: (tool, input, p) => askNotion(agent.id, tool, input, p, controller.signal) });
  const running = runUpdate(h, UPDATE_TOOL, { page_id: ID, command: "insert_content", content: "z" }, controller.signal);
  await new Promise((r) => setTimeout(r, 30));
  controller.abort();
  await running;
  expect(calls.write.length === 0 && lastPermission().status === "denied", "abort");
});

test("respondNotionWrite: Notion 제안이 아닌 항목이나 이미 처리된 항목은 거절", () => {
  let threw = 0;
  try {
    runner.respondNotionWrite(agent.id, "nope", true);
  } catch {
    threw++;
  }
  expect(threw === 1, "없는 항목");
});

// ---- NOTION3: Bypass Permissions 에서 카드 없이 바로 반영 ----

const permissionsOf = (id: string) => store.timeline(id).filter((i) => i.kind === "permission") as Extract<import("../shared/protocol").TimelineItem, { kind: "permission" }>[];
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const update = { page_id: ID, command: "update_content" as const, content_updates: [{ old_str: "- one", new_str: "- uno" }] };

test("판정 notionWriteGate: Bypass Permissions 이고 설정이 apply 일 때만 apply, 나머지 모드와 이상한 값은 전부 ask", () => {
  expect(notionWriteGate("bypassPermissions", "apply") === "apply", "bypass + apply");
  expect(notionWriteGate("bypassPermissions", "ask") === "ask", "bypass + ask");
  for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk", "", undefined, null, 1]) expect(notionWriteGate(mode, "apply") === "ask", `${String(mode)} + apply`);
  for (const setting of [undefined, null, "", "yes", true, 1, "Apply"]) expect(notionWriteGate("bypassPermissions", setting) === "ask", `bypass + ${String(setting)}`);
});

test("설정: 새 홈의 기본값은 apply, 이상한 값은 저장되지 않는다", () => {
  expect(initialBypassWrites === "apply", `기본 ${String(initialBypassWrites)}`);
  store.updateSettings({ notionBypassWrites: "ask" });
  store.updateSettings({ notionBypassWrites: "garbage" as never });
  expect(store.settings.notionBypassWrites === "ask", "garbage 는 이전 값을 바꾸지 못한다");
  store.updateSettings({ notionBypassWrites: "apply" });
  expect(store.settings.notionBypassWrites === "apply", "apply 저장");
});

test("PreToolUse 훅 판정: allowDirect 가 정확히 true 일 때만 Notion 쓰기를 통과시킨다", () => {
  const hook = (options?: { allowDirect?: boolean }) => notionWriteGuard({ hook_event_name: "PreToolUse", tool_name: "mcp__notion__notion-delete-pages" }, options);
  const denied = (o: ReturnType<typeof hook>) => "hookSpecificOutput" in o && o.hookSpecificOutput.permissionDecision === "deny";
  expect(denied(hook()) && denied(hook({})) && denied(hook({ allowDirect: false })) && denied(hook({ allowDirect: 1 as never })) && denied(hook({ allowDirect: "true" as never })), "true 가 아니면 deny");
  expect(JSON.stringify(hook({ allowDirect: true })) === "{}", "true 면 통과");
});

test("Bypass Permissions + apply: 카드 없이 바로 쓰고, 처리된 승인 항목과 미리보기가 남는다", async () => {
  store.updateSettings({ notionBypassWrites: "apply" });
  makeAgent("n-auto", "bypassPermissions");
  const { host: h, calls } = host({ ask: (tool, input, p, signal) => askNotion("n-auto", tool, input, p, signal) });
  const { result } = await runUpdate(h, UPDATE_TOOL, update);
  const items = permissionsOf("n-auto");
  expect(items.length === 1 && items[0].status === "allowed" && items[0].auto === true && items[0].notion?.diff?.after === "## Goals\n- uno", JSON.stringify(items));
  expect(store.agent("n-auto").status === "idle", "waiting 으로 바뀌지 않는다");
  expect(calls.write.length === 1 && JSON.stringify(result.content).includes("Applied to Notion"), "쓰기 한 번");
  same(calls.write[0].args, update);
});

test("Bypass Permissions + apply: 같은 도구 호출에 이어 붙는다 (진행 줄과 한 줄)", async () => {
  makeAgent("n-link", "bypassPermissions");
  store.upsertItem("n-link", { id: "tool-1", kind: "tool", name: UPDATE_TOOL, input: update, status: "running", output: null });
  const { host: h } = host({ ask: (tool, input, p, signal) => askNotion("n-link", tool, input, p, signal) });
  await runUpdate(h, UPDATE_TOOL, update);
  expect(permissionsOf("n-link")[0]?.toolUseId === "tool-1", "toolUseId");
});

test("Bypass Permissions + Always ask: 카드가 뜨고 답이 올 때까지 쓰기가 없다", async () => {
  store.updateSettings({ notionBypassWrites: "ask" });
  makeAgent("n-ask", "bypassPermissions");
  const { host: h, calls } = host({ ask: (tool, input, p, signal) => askNotion("n-ask", tool, input, p, signal) });
  const running = runUpdate(h, UPDATE_TOOL, update);
  await wait();
  const item = permissionsOf("n-ask")[0];
  expect(item.status === "pending" && !item.auto && calls.write.length === 0, "대기");
  runner.respondNotionWrite("n-ask", item.id, false);
  await running;
});

test("다른 모드(Ask Before Edits, Edit Automatically, Plan, Auto)는 설정이 apply 여도 카드", async () => {
  store.updateSettings({ notionBypassWrites: "apply" });
  for (const mode of ["default", "acceptEdits", "plan", "auto"]) {
    const id = `n-mode-${mode}`;
    makeAgent(id, mode);
    const { host: h, calls } = host({ ask: (tool, input, p, signal) => askNotion(id, tool, input, p, signal) });
    const running = runUpdate(h, UPDATE_TOOL, update);
    await wait();
    const item = permissionsOf(id)[0];
    expect(item?.status === "pending" && calls.write.length === 0, `${mode}: 카드`);
    runner.respondNotionWrite(id, item.id, true);
    await running;
    expect(calls.write.length === 1 && permissionsOf(id)[0].auto !== true, `${mode}: 누른 승인은 auto 가 아니다`);
  }
});

test("카드가 떠 있는 동안 Bypass Permissions 로 바꾸면 그 카드도 바로 통과한다", async () => {
  store.updateSettings({ notionBypassWrites: "apply" });
  makeAgent("n-switch", "default");
  const { host: h, calls } = host({ ask: (tool, input, p, signal) => askNotion("n-switch", tool, input, p, signal) });
  const running = runUpdate(h, UPDATE_TOOL, update);
  await wait();
  expect(permissionsOf("n-switch")[0].status === "pending", "처음엔 카드");
  await runner.setPermissionMode("n-switch", "bypassPermissions");
  const { result } = await running;
  const item = permissionsOf("n-switch")[0];
  expect(item.status === "allowed" && item.auto === true && calls.write.length === 1 && JSON.stringify(result.content).includes("Applied"), JSON.stringify(item));
});

test("카드가 떠 있는 동안 Bypass Permissions 에서 나가면 다음 쓰기부터 카드로 돌아간다", async () => {
  makeAgent("n-leave", "bypassPermissions");
  const first = host({ ask: (tool, input, p, signal) => askNotion("n-leave", tool, input, p, signal) });
  await runUpdate(first.host, UPDATE_TOOL, update);
  expect(first.calls.write.length === 1 && permissionsOf("n-leave").length === 1, "Bypass 에서는 바로");
  await runner.setPermissionMode("n-leave", "default");
  const second = host({ ask: (tool, input, p, signal) => askNotion("n-leave", tool, input, p, signal) });
  const running = runUpdate(second.host, UPDATE_TOOL, update);
  await wait();
  const pending = permissionsOf("n-leave").at(-1)!;
  expect(pending.status === "pending" && second.calls.write.length === 0, "나오면 카드");
  runner.respondNotionWrite("n-leave", pending.id, false);
  await running;
});

test("설정이 Always ask 면 Bypass Permissions 로 바꿔도 카드가 남고, 설정을 apply 로 바꾸면 그때 통과한다", async () => {
  store.updateSettings({ notionBypassWrites: "ask" });
  makeAgent("n-setting", "default");
  const { host: h, calls } = host({ ask: (tool, input, p, signal) => askNotion("n-setting", tool, input, p, signal) });
  const running = runUpdate(h, UPDATE_TOOL, update);
  await wait();
  await runner.setPermissionMode("n-setting", "bypassPermissions");
  expect(permissionsOf("n-setting")[0].status === "pending" && calls.write.length === 0, "ask 설정이면 그대로 대기");
  store.updateSettings({ notionBypassWrites: "apply" });
  runner.releaseNotionCards();
  await running;
  expect(permissionsOf("n-setting")[0].status === "allowed" && permissionsOf("n-setting")[0].auto === true && calls.write.length === 1, "설정을 바꾸면 통과");
});

test("피드백 개선 세션은 Bypass Permissions + apply 여도 자동으로 쓰지 않는다", async () => {
  store.updateSettings({ notionBypassWrites: "apply" });
  makeAgent("n-fb", "bypassPermissions", { feedbackId: "fb-1" });
  const { host: h, calls } = host({ ask: (tool, input, p, signal) => askNotion("n-fb", tool, input, p, signal) });
  const running = runUpdate(h, UPDATE_TOOL, update);
  await wait();
  expect(permissionsOf("n-fb")[0].status === "pending" && calls.write.length === 0, "카드");
  runner.respondNotionWrite("n-fb", permissionsOf("n-fb")[0].id, false);
  await running;
});

type Guard = (agentId: string, input: Record<string, unknown>) => Record<string, unknown>;
const guardOf = (agentId: string, input: Record<string, unknown>) => (runner as unknown as { guardNotionWrite: Guard }).guardNotionWrite(agentId, { hook_event_name: "PreToolUse", ...input });
const isDeny = (o: Record<string, unknown>) => (o.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === "deny";
const DELETE_TOOL = "mcp__notion__notion-delete-pages";

test("직접 쓰기 훅: Bypass Permissions + apply 에서만 통과하고 기록 줄을 남긴다 (삭제와 이동 포함)", () => {
  store.updateSettings({ notionBypassWrites: "apply" });
  makeAgent("n-guard", "bypassPermissions");
  for (const tool of [DELETE_TOOL, "mcp__notion__notion-move-pages", "mcp__notion__notion-update-page"]) expect(!isDeny(guardOf("n-guard", { tool_name: tool, tool_input: { page_id: ID } })), `${tool} 통과`);
  const notices = store.timeline("n-guard").filter((i) => i.kind === "notice");
  expect(notices.length === 3 && notices[0].kind === "notice" && notices[0].text.includes("allowed by Bypass Permissions") && notices[0].text.includes("notion-delete-pages") && !!notices[0].fold?.text.includes(ID), JSON.stringify(notices));
  expect(!isDeny(guardOf("n-guard", { tool_name: "mcp__notion__notion-fetch" })) && store.timeline("n-guard").filter((i) => i.kind === "notice").length === 3, "읽기는 기록 줄 없이 통과");
});

test("직접 쓰기 훅: 다른 모드, Always ask, CLI 가 알려 준 모드가 Bypass 가 아닐 때는 deny 이고 기록 줄도 없다", () => {
  store.updateSettings({ notionBypassWrites: "apply" });
  for (const mode of ["default", "acceptEdits", "plan", "auto"]) {
    makeAgent(`n-guard-${mode}`, mode);
    expect(isDeny(guardOf(`n-guard-${mode}`, { tool_name: DELETE_TOOL })), `${mode} deny`);
    expect(store.timeline(`n-guard-${mode}`).length === 0, `${mode} 기록 없음`);
  }
  expect(isDeny(guardOf("n-guard", { tool_name: DELETE_TOOL, permission_mode: "default" })), "CLI 모드가 default 면 deny");
  expect(!isDeny(guardOf("n-guard", { tool_name: DELETE_TOOL, permission_mode: "bypassPermissions" })), "CLI 모드도 bypass 면 통과");
  store.updateSettings({ notionBypassWrites: "ask" });
  const before = store.timeline("n-guard").length;
  expect(isDeny(guardOf("n-guard", { tool_name: DELETE_TOOL })) && store.timeline("n-guard").length === before, "Always ask 면 Bypass 에서도 deny");
  expect(isDeny(guardOf("no-such-agent", { tool_name: DELETE_TOOL })), "모르는 세션도 deny (판정 실패는 막는다)");
});

let failed = 0;
for (const c of cases) {
  try {
    await c.run();
    console.log(`ok   ${c.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
