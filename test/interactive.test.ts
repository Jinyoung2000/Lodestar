import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-interactive-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });

const { cleanAnswers, isInteractiveTool, keepPlanningMessage, planResult, planText, questionResult, readQuestions } = await import("../server/interactiveTools");
const { AgentRunner } = await import("../server/agents");
const { Store } = await import("../server/store");
const { isInternalStep } = await import("../shared/internalSteps");
const { checkImage, imageProblemText, MAX_IMAGES, MAX_IMAGE_BYTES, sniffImageType } = await import("../shared/images");
const { imageBlock, imageBlocks, removeImages, saveImage } = await import("../server/images");
const { userMessage } = await import("../server/turnInput");
const { answerOf, answersOf, emptyQuestionState, isAnswered, toggleOther, togglePick } = await import("../shared/interactive");
const { clipboardImageFiles, dragHasFiles } = await import("../shared/images");
const { applyMention, applyTrigger, findTrigger, removeMention } = await import("../web/composerState");
const { approvalInputView, spacedJson } = await import("../web/approvalInput");
const { groupTurns, interactiveStep } = await import("../web/timelineModel");
type ServerEvent = import("../shared/protocol").ServerEvent;
type PermissionResult = import("@anthropic-ai/claude-agent-sdk").PermissionResult;

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

const input = {
  questions: [
    { question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] },
    { question: "Which fruits?", header: "Fruit", multiSelect: true, options: [{ label: "Apple", description: "" }, { label: "Pear", description: "" }] },
  ],
};

test("readQuestions: 질문, header, multiSelect, 선택지를 읽고 어긋난 항목은 건너뛴다", () => {
  const list = readQuestions({ questions: [...input.questions, null, { question: "", options: [] }, { question: "No options" }, "x"] });
  expect(list.length === 3, `질문 3개(마지막 하나는 선택지 없음) ${list.length}`);
  expect(list[0].header === "Color" && list[0].options.length === 2 && list[0].options[1].label === "Blue", "첫 질문");
  expect(list[1].multiSelect === true, "multiSelect");
  expect(list[2].options.length === 0, "선택지가 없으면 빈 목록");
  expect(readQuestions({}).length === 0, "questions 가 없으면 빈 목록");
});

test("cleanAnswers: 질문 글에 맞는 답만 남기고 공백을 다듬는다", () => {
  const out = cleanAnswers(input, { "Which color?": "  Blue ", "Which fruits?": "Apple, Pear", "Unknown?": "x", "": "y" });
  expect(out["Which color?"] === "Blue" && out["Which fruits?"] === "Apple, Pear", JSON.stringify(out));
  expect(Object.keys(out).length === 2, "없는 질문의 답은 버린다");
  expect(Object.keys(cleanAnswers(input, { "Which color?": "   ", "Which fruits?": 3 })).length === 0, "빈 글과 문자열이 아닌 값은 뺀다");
  expect(cleanAnswers(input, { "Which color?": "x".repeat(9000) })["Which color?"].length === 4000, "너무 긴 답은 자른다");
});

test("questionResult: allow 와 updatedInput.answers 로 돌려주고 원래 입력은 그대로 둔다", () => {
  const { result, answers } = questionResult(input, { "Which color?": "Blue" });
  expect(result.behavior === "allow", "allow");
  const updated = (result as Extract<PermissionResult, { behavior: "allow" }>).updatedInput as { questions: unknown; answers: Record<string, string> };
  expect(updated.answers["Which color?"] === "Blue", JSON.stringify(updated.answers));
  expect(updated.questions === input.questions, "questions 는 그대로 따라간다");
  expect(JSON.stringify(answers) === '{"Which color?":"Blue"}', "화면에 남길 답");
  expect(!("answers" in input), "입력 객체를 바꾸지 않는다");
});

test("questionResult: 답 없이 넘기면(null) 빈 answers 로 허용해 CLI 가 답하지 않았다는 결과를 만든다", () => {
  const { result, answers } = questionResult(input, null);
  expect(result.behavior === "allow", "deny 가 아니다");
  expect(Object.keys((result as unknown as { updatedInput: { answers: object } }).updatedInput.answers).length === 0 && Object.keys(answers).length === 0, "빈 답");
});

test("planResult: 진행은 setMode 를 담은 allow, 계속 계획은 사용자 글이 든 deny", () => {
  const plan = { plan: "# Plan" };
  const approved = planResult(plan, { approve: true, mode: "acceptEdits" }) as Extract<PermissionResult, { behavior: "allow" }>;
  expect(approved.behavior === "allow" && approved.updatedInput === plan, "allow 와 입력 그대로");
  expect(JSON.stringify(approved.updatedPermissions) === '[{"type":"setMode","mode":"acceptEdits","destination":"session"}]', JSON.stringify(approved.updatedPermissions));
  const manual = planResult(plan, { approve: true, mode: "default" }) as Extract<PermissionResult, { behavior: "allow" }>;
  expect(manual.updatedPermissions?.[0].type === "setMode" && (manual.updatedPermissions[0] as { mode: string }).mode === "default", "편집 전 확인 모드");
  const kept = planResult(plan, { approve: false, feedback: " add tests " }) as Extract<PermissionResult, { behavior: "deny" }>;
  expect(kept.behavior === "deny" && kept.message.includes("keep planning") && kept.message.endsWith("add tests"), kept.message);
  expect(!keepPlanningMessage().includes("feedback"), "글이 없으면 피드백 문단이 없다");
  expect(!keepPlanningMessage("   ").includes("feedback"), "공백뿐이면 없는 것과 같다");
});

test("planText 와 isInteractiveTool", () => {
  expect(planText({ plan: "  # A\n" }) === "# A", "plan 글");
  expect(planText({}) === null && planText({ plan: "  " }) === null, "없으면 null");
  expect(isInteractiveTool("AskUserQuestion") && isInteractiveTool("ExitPlanMode") && !isInteractiveTool("Bash"), "두 도구만");
});

const store = new Store();
const events: ServerEvent[] = [];
const runner = new AgentRunner(store, (e) => events.push(e));
type Pending = { toolName: string };
const pendingMap = () => (runner as unknown as { pending: Map<string, Pending> }).pending;
const ask = (agentId: string, tool: string, toolInput: Record<string, unknown>) => (runner as unknown as { askPermission: (a: string, t: string, i: Record<string, unknown>, s: AbortSignal, u?: string) => Promise<PermissionResult> }).askPermission(agentId, tool, toolInput, new AbortController().signal, "tu-1");
const agent = (() => {
  const now = new Date().toISOString();
  const a = {
    id: "a-1", workspaceId: null, cwd: home, worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: "t", sessionId: null, status: "idle", permissionMode: "plan", model: null, effort: null, activeModel: null, activeEffort: null, backgroundTasks: 0, createdAt: now, updatedAt: now,
  } as unknown as Parameters<typeof store.addAgent>[0];
  store.addAgent(a);
  return a;
})();
const permissionItem = () => store.timeline(agent.id).filter((i) => i.kind === "permission").at(-1) as Extract<import("../shared/protocol").TimelineItem, { kind: "permission" }>;
const lastPendingId = () => permissionItem().id;

test("answerQuestion: 답이 SDK 결과(updatedInput.answers)가 되고 타임라인 승인 항목에 outcome 으로 남는다", async () => {
  const promise = ask(agent.id, "AskUserQuestion", input);
  const id = lastPendingId();
  expect(permissionItem().status === "pending", "대기 중");
  runner.answerQuestion(agent.id, id, { "Which color?": "Blue", "Which fruits?": "Apple, Pear" });
  const result = (await promise) as Extract<PermissionResult, { behavior: "allow" }>;
  expect(result.behavior === "allow", "allow");
  const answers = (result.updatedInput as { answers: Record<string, string> }).answers;
  expect(answers["Which color?"] === "Blue" && answers["Which fruits?"] === "Apple, Pear", JSON.stringify(answers));
  expect(result.updatedPermissions === undefined, "질문은 이 세션에서 다시 묻지 않는 허용 규칙을 만들지 않는다");
  const item = permissionItem();
  expect(item.status === "allowed" && item.outcome?.answers?.["Which color?"] === "Blue", "outcome 저장");
  expect(!pendingMap().has(`${agent.id}:${id}`), "대기 목록에서 빠진다");
});

test("respondPermission: 질문과 계획은 허용 단추로 답할 수 없고, 넘기기만 받는다", async () => {
  const promise = ask(agent.id, "AskUserQuestion", input);
  const id = lastPendingId();
  let threw = false;
  try {
    runner.respondPermission(agent.id, id, "allow");
  } catch {
    threw = true;
  }
  expect(threw, "allow 는 거절");
  try {
    runner.respondPermission(agent.id, id, "allowAlways");
    expect(false, "allowAlways 도 거절");
  } catch {
  }
  runner.respondPermission(agent.id, id, "deny");
  const result = (await promise) as Extract<PermissionResult, { behavior: "allow" }>;
  expect(result.behavior === "allow" && Object.keys((result.updatedInput as { answers: object }).answers).length === 0, "넘기면 빈 answers");
  expect(permissionItem().outcome?.answers !== undefined, "넘긴 것도 outcome 이 남는다");
});

test("answerQuestion: 계획 승인 항목에는 쓸 수 없다", async () => {
  const promise = ask(agent.id, "ExitPlanMode", { plan: "# P" });
  const id = lastPendingId();
  let threw = false;
  try {
    runner.answerQuestion(agent.id, id, { x: "y" });
  } catch {
    threw = true;
  }
  expect(threw, "도구가 다르면 거절");
  runner.respondPlan(agent.id, id, { approve: false });
  await promise;
});

test("respondPlan: 진행하면 권한 모드가 세션과 이벤트에 반영되고 SDK 결과에 setMode 가 든다", async () => {
  const before = events.length;
  const promise = ask(agent.id, "ExitPlanMode", { plan: "# P" });
  const id = lastPendingId();
  runner.respondPlan(agent.id, id, { approve: true, mode: "acceptEdits" });
  const result = (await promise) as Extract<PermissionResult, { behavior: "allow" }>;
  expect(result.behavior === "allow" && (result.updatedPermissions?.[0] as { mode?: string })?.mode === "acceptEdits", "setMode acceptEdits");
  expect(store.agent(agent.id).permissionMode === "acceptEdits", "세션의 모드가 바뀐다");
  expect(events.slice(before).some((e) => e.type === "agent" && e.agent.permissionMode === "acceptEdits"), "agent 이벤트");
  const item = permissionItem();
  expect(item.outcome?.plan?.decision === "approved" && item.status === "allowed", "outcome");
  const manual = ask(agent.id, "ExitPlanMode", { plan: "# P2" });
  runner.respondPlan(agent.id, lastPendingId(), { approve: true, mode: "default" });
  await manual;
  expect(store.agent(agent.id).permissionMode === "default", "편집 전 확인으로도 바뀐다");
});

test("respondPlan: 계속 계획은 deny 와 사용자 글이고 모드는 그대로다", async () => {
  store.patchAgent(agent.id, { permissionMode: "plan" });
  const promise = ask(agent.id, "ExitPlanMode", { plan: "# P" });
  runner.respondPlan(agent.id, lastPendingId(), { approve: false, feedback: "Also cover tests" });
  const result = (await promise) as Extract<PermissionResult, { behavior: "deny" }>;
  expect(result.behavior === "deny" && result.message.includes("Also cover tests"), result.message);
  expect(store.agent(agent.id).permissionMode === "plan", "plan 유지");
  const outcome = permissionItem().outcome?.plan;
  expect(outcome?.decision === "kept" && outcome.feedback === "Also cover tests", "outcome 에 글");
  expect(permissionItem().status === "denied", "denied");
});

test("계획 승인을 넘기기(deny)로 닫아도 계속 계획으로 처리한다", async () => {
  const promise = ask(agent.id, "ExitPlanMode", { plan: "# P" });
  runner.respondPermission(agent.id, lastPendingId(), "deny");
  const result = (await promise) as Extract<PermissionResult, { behavior: "deny" }>;
  expect(result.behavior === "deny" && result.message.includes("keep planning"), result.message);
  expect(permissionItem().outcome?.plan?.decision === "kept", "kept");
});

test("일반 도구의 승인은 그대로다: Allow in this Session 은 addRules, 거절은 deny", async () => {
  const a = ask(agent.id, "Bash", { command: "ls" });
  runner.respondPermission(agent.id, lastPendingId(), "allowAlways");
  const allowed = (await a) as Extract<PermissionResult, { behavior: "allow" }>;
  expect(allowed.updatedPermissions?.[0].type === "addRules", "규칙");
  expect(permissionItem().outcome === undefined, "outcome 없음");
  const b = ask(agent.id, "Bash", { command: "ls" });
  runner.respondPermission(agent.id, lastPendingId(), "deny");
  expect(((await b) as { behavior: string }).behavior === "deny", "deny");
});

test("isInternalStep: ToolSearch 와 계획 파일(~/.claude/plans)만 숨기고 실패한 호출과 다른 파일은 보인다", () => {
  expect(isInternalStep("ToolSearch", { query: "select:ExitPlanMode" }, "done"), "ToolSearch");
  expect(isInternalStep("Write", { file_path: "/Users/me/.claude/plans/plan-x.md" }, "done"), "계획 파일 쓰기");
  expect(isInternalStep("Edit", { file_path: "/Users/me/.claude/plans/plan-x.md" }, "done") && isInternalStep("Read", { file_path: "/Users/me/.claude/plans/a.md" }, "done"), "고치기와 읽기");
  expect(!isInternalStep("Write", { file_path: "/Users/me/proj/docs/plans/x.md" }, "done"), "프로젝트의 plans 폴더는 숨기지 않는다");
  expect(!isInternalStep("Write", { file_path: "/Users/me/.claude/plans/sub/x.md" }, "done"), "하위 폴더는 계획 파일이 아니다");
  expect(!isInternalStep("Write", { file_path: "/Users/me/.claude/plans/x.txt" }, "done"), "md 만");
  expect(!isInternalStep("ToolSearch", { query: "x" }, "error"), "실패는 보인다");
  expect(!isInternalStep("Bash", { command: "ls ~/.claude/plans/x.md" }, "done"), "Bash 는 건드리지 않는다");
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

test("sniffImageType: 앞머리 바이트로 png, jpeg, gif, webp 를 가린다", () => {
  expect(sniffImageType(PNG) === "image/png" && sniffImageType(JPEG) === "image/jpeg" && sniffImageType(GIF) === "image/gif" && sniffImageType(WEBP) === "image/webp", "네 형식");
  expect(sniffImageType(Buffer.from("<svg xmlns=...>")) === null && sniffImageType(Buffer.alloc(0)) === null && sniffImageType(Buffer.from("RIFF....WAVE")) === null, "svg, 빈 파일, 다른 RIFF");
});

test("checkImage: 형식, 크기, 빈 파일, 장수 상한을 이유와 함께 거른다", () => {
  expect(checkImage("image/png", 1000, 0) === null, "정상");
  expect(checkImage("image/svg+xml", 1000, 0) === "format" && checkImage("application/pdf", 10, 0) === "format" && checkImage("", 10, 0) === "format", "형식");
  expect(checkImage("image/png", MAX_IMAGE_BYTES + 1, 0) === "size" && checkImage("image/png", MAX_IMAGE_BYTES, 0) === null, "5MB 경계");
  expect(checkImage("image/png", 0, 0) === "empty", "빈 파일");
  expect(checkImage("image/png", 10, MAX_IMAGES) === "count" && checkImage("image/png", 10, MAX_IMAGES - 1) === null, "장수");
  expect(imageProblemText("format", "a.svg").startsWith("a.svg:") && imageProblemText("count", "x").includes(String(MAX_IMAGES)), "안내 문구");
});

test("saveImage: 저장하고 id 로 image 블록을 읽는다. 이름이 jpeg 라도 실제 형식(png)으로 보낸다", () => {
  const { id } = saveImage({ mediaType: "image/jpeg", data: PNG.toString("base64"), name: "shot.jpg" });
  const block = imageBlock(id);
  expect(block?.source.media_type === "image/png" && block.source.data === PNG.toString("base64"), "실제 형식과 데이터");
  expect(readdirSync(join(home, "nav", "images")).some((f) => f === `${id}.png`), "확장자는 실제 형식");
  expect(imageBlock("../../etc/passwd") === null && imageBlock("0".repeat(36)) === null, "엉뚱한 id 는 읽지 않는다");
  const blocks = imageBlocks([{ kind: "image", id }, { kind: "screenshot" }, { kind: "image", id: "00000000-0000-0000-0000-000000000000" }]);
  expect(blocks.length === 1, "이미지 칩만 블록이 되고 사라진 파일은 건너뛴다");
  removeImages([id]);
  expect(imageBlock(id) === null, "지우면 읽히지 않는다");
});

test("saveImage: 형식이 틀리거나 너무 크면 이유를 담아 거절한다", () => {
  const fail = (params: { mediaType: string; data: string; name: string }) => {
    try {
      saveImage(params);
    } catch (error) {
      return (error as Error).message;
    }
    return null;
  };
  expect(fail({ mediaType: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64"), name: "a.svg" })?.includes("only PNG") === true, "svg 거절");
  expect(fail({ mediaType: "image/png", data: Buffer.from("not an image at all").toString("base64"), name: "fake.png" })?.includes("only PNG") === true, "이름은 png 인데 내용이 아니면 거절");
  expect(fail({ mediaType: "image/png", data: "", name: "e.png" })?.includes("empty") === true, "빈 데이터");
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
  expect(fail({ mediaType: "image/png", data: big.toString("base64"), name: "big.png" })?.includes("5 MB") === true, "5MB 초과");
});

test("userMessage: 이미지가 있으면 글 블록과 image 블록의 배열, 글이 없으면 image 블록만", () => {
  const { id } = saveImage({ mediaType: "image/png", data: PNG.toString("base64"), name: "a.png" });
  const blocks = imageBlocks([{ kind: "image", id }]);
  const withText = userMessage("describe", "u1", undefined, blocks).message.content as { type: string }[];
  expect(Array.isArray(withText) && withText[0].type === "text" && withText[1].type === "image", "글 다음 이미지");
  const only = userMessage("", "u2", undefined, blocks).message.content as { type: string }[];
  expect(only.length === 1 && only[0].type === "image", "빈 글 블록은 만들지 않는다(API 가 거절)");
  expect(userMessage("plain", "u3").message.content === "plain", "이미지가 없으면 예전처럼 문자열");
  writeFileSync(join(home, "done"), "");
});

const qs = readQuestions(input);

test("질문 선택: 하나만 고르는 질문은 바꿔 고르면 이전 선택이 빠지고 Other 도 꺼진다", () => {
  let state = emptyQuestionState();
  state = togglePick(qs[0], state, "Red");
  state = togglePick(qs[0], state, "Blue");
  expect(JSON.stringify(state.picked) === '["Blue"]', JSON.stringify(state));
  state = toggleOther(qs[0], { ...state, text: "Green" });
  expect(state.other === true && state.picked.length === 0, "Other 를 고르면 선택지 선택이 비워진다");
  expect(answerOf(qs[0], state) === "Green", "Other 글이 답");
  state = togglePick(qs[0], state, "Red");
  expect(state.other === false && answerOf(qs[0], state) === "Red", "선택지를 다시 고르면 Other 가 꺼진다");
});

test("질문 선택: 여러 개 고르는 질문은 켜고 끄고, 답은 선택지 순서대로 ', ' 로 잇고 Other 글을 맨 뒤에 둔다", () => {
  let state = emptyQuestionState();
  state = togglePick(qs[1], state, "Pear");
  state = togglePick(qs[1], state, "Apple");
  expect(answerOf(qs[1], state) === "Apple, Pear", "선택지 순서(Apple, Pear)이지 누른 순서가 아니다");
  state = togglePick(qs[1], state, "Pear");
  expect(answerOf(qs[1], state) === "Apple", "한 번 더 누르면 빠진다");
  state = toggleOther(qs[1], { ...state, text: " Plum " });
  expect(answerOf(qs[1], state) === "Apple, Plum", "Other 는 같이 이어진다");
  expect(answerOf(qs[1], { picked: [], other: true, text: "  " }) === "", "Other 를 켰지만 글이 없으면 답이 없다");
});

test("질문 선택: 모든 질문에 답이 있어야 보내진다", () => {
  const states = qs.map(emptyQuestionState);
  expect(!isAnswered(qs, states), "아무것도 안 골랐다");
  states[0] = togglePick(qs[0], states[0], "Blue");
  expect(!isAnswered(qs, states), "하나만 골랐다");
  states[1] = togglePick(qs[1], states[1], "Apple");
  expect(isAnswered(qs, states), "둘 다 골랐다");
  const answers = answersOf(qs, states);
  expect(answers["Which color?"] === "Blue" && answers["Which fruits?"] === "Apple", JSON.stringify(answers));
  expect(!isAnswered([], []), "질문이 없으면 보낼 것이 없다");
});

const labels = { asked: "Asked", ask: "Ask", skipped: "Skipped", planApproved: "Approved plan", planKept: "Kept planning", planWaiting: "Plan ready", feedback: "Feedback", after: (mode: string) => `After: ${mode}` };
type TimelineItem = import("../shared/protocol").TimelineItem;
const permission = (status: "pending" | "allowed" | "denied", outcome?: import("../shared/protocol").PermissionOutcome, tool = "AskUserQuestion", toolInput: Record<string, unknown> = input) => ({ id: "p", kind: "permission" as const, toolName: tool, input: toolInput, status, ...(outcome ? { outcome } : {}) });

test("interactiveStep: 대기, 답함, 넘김을 구분하고 답한 질문과 답을 돌려준다", () => {
  expect(interactiveStep("AskUserQuestion", input, permission("pending"), false, labels).state === "pending", "대기");
  expect(interactiveStep("AskUserQuestion", input, null, false, labels).state === "pending", "도구는 도는데 승인 항목이 아직 없으면 대기");
  const done = interactiveStep("AskUserQuestion", input, permission("allowed", { answers: { "Which color?": "Blue" } }), true, labels);
  expect(done.state === "done" && done.verb === "Asked" && done.qa.length === 1 && done.qa[0].answer === "Blue" && done.detail === "2 questions", JSON.stringify(done));
  const skipped = interactiveStep("AskUserQuestion", input, permission("allowed", { answers: {} }), true, labels);
  expect(skipped.state === "skipped" && skipped.verb === "Skipped" && skipped.qa.length === 0, "빈 답은 넘김");
  expect(interactiveStep("AskUserQuestion", input, null, true, labels).state === "done", "승인 기록이 없던 옛 타임라인은 끝난 것으로");
});

test("interactiveStep: 계획 승인은 승인과 계속 계획과 피드백을 보인다", () => {
  const plan = { plan: "# Add sub\n\n- one" };
  const waiting = interactiveStep("ExitPlanMode", plan, permission("pending", undefined, "ExitPlanMode", plan), false, labels);
  expect(waiting.state === "pending" && waiting.detail === "Add sub" && waiting.plan?.startsWith("# Add sub") === true, JSON.stringify(waiting));
  const approved = interactiveStep("ExitPlanMode", plan, permission("allowed", { plan: { decision: "approved", mode: "acceptEdits" } }, "ExitPlanMode", plan), true, labels);
  expect(approved.state === "done" && approved.verb === "Approved plan" && approved.note === "After: acceptEdits", JSON.stringify(approved));
  const kept = interactiveStep("ExitPlanMode", plan, permission("denied", { plan: { decision: "kept", feedback: "More tests" } }, "ExitPlanMode", plan), true, labels);
  expect(kept.state === "skipped" && kept.verb === "Kept planning" && kept.note === "Feedback: More tests", JSON.stringify(kept));
});

test("groupTurns: ToolSearch 와 계획 파일 단계는 단계 목록에서 빠지고 질문 단계는 남는다", () => {
  const items: TimelineItem[] = [
    { id: "u", kind: "user", text: "plan it" },
    { id: "t1", kind: "tool", name: "Write", input: { file_path: "/Users/me/.claude/plans/p.md", content: "x" }, status: "done", output: "ok" },
    { id: "t2", kind: "tool", name: "ToolSearch", input: { query: "select:ExitPlanMode" }, status: "done", output: "ok" },
    { id: "t3", kind: "tool", name: "ExitPlanMode", input: { plan: "# P" }, status: "done", output: "ok" },
    { id: "p3", kind: "permission", toolUseId: "t3", toolName: "ExitPlanMode", input: { plan: "# P" }, status: "allowed" },
    { id: "t4", kind: "tool", name: "Write", input: { file_path: "/proj/a.ts", content: "x" }, status: "done", output: "ok" },
  ];
  const blocks = groupTurns(items);
  const steps = blocks.flatMap((b) => (b.kind === "steps" ? b.items.map((e) => e.item.id) : []));
  expect(steps.join() === "t3,t4", `남은 단계 ${steps.join()}`);
  const step = blocks.flatMap((b) => (b.kind === "steps" ? b.items : [])).find((e) => e.item.id === "t3");
  expect(step?.permission?.id === "p3", "ExitPlanMode 호출과 승인이 한 줄로 짝지어진다");
});

test("approvalInputView: Bash 명령, Fetch URL, Search 질의가 대상 줄에 오고 Input 에서는 빠진다", () => {
  const bash = approvalInputView("Bash", { command: "ls -la", description: "list" });
  expect(bash.target?.kind === "command" && bash.target.text === "ls -la" && !("command" in bash.rest) && "description" in bash.rest, "명령은 빠지고 설명은 남는다");
  expect(Object.keys(approvalInputView("Bash", { command: "ls" }).rest).length === 0, "명령뿐이면 Input 이 없다");
  const multi = approvalInputView("Bash", { command: "echo a\necho b" });
  expect(multi.target?.text === "echo a" && "command" in multi.rest, "여러 줄 명령은 전문이 Input 에 남는다");
  const long = approvalInputView("Bash", { command: "x".repeat(200) });
  expect(long.target?.text.length === 120 && "command" in long.rest, "긴 명령도 전문이 남는다");
  const fetch = approvalInputView("WebFetch", { url: "https://example.com", prompt: "Summarize" });
  expect(fetch.target?.kind === "url" && fetch.target.text === "https://example.com" && !("url" in fetch.rest) && fetch.rest.prompt === "Summarize", "Fetch");
  const search = approvalInputView("WebSearch", { query: "claude" });
  expect(search.target?.kind === "query" && Object.keys(search.rest).length === 0, "Search");
  expect(approvalInputView("Skill", { skill: "x" }).target === null, "그 밖의 도구는 대상 줄이 없다");
  expect(approvalInputView("WebFetch", {}).target === null, "url 이 없으면 대상 없음");
  expect(spacedJson({ a: 1, b: "x" }) === '{ "a": 1, "b": "x" }' && spacedJson({}) === "{}", "한 줄 JSON");
});

test("applyMention: @검색어를 문장 안의 @경로 로 바꾸고 이중 공백이 생기지 않는다", () => {
  const typed = "look at @pri";
  const trigger = findTrigger(typed, typed.length)!;
  const out = applyMention(typed, trigger, "src/price.js");
  expect(out.text === "look at @src/price.js " && out.caret === out.text.length, JSON.stringify(out));
  const next = out.text + "and fix it";
  expect(next === "look at @src/price.js and fix it" && !next.includes("  "), next);
  const mid = "look at @pri and more";
  const midOut = applyMention(mid, findTrigger(mid, "look at @pri".length)!, "src/price.js");
  expect(midOut.text === "look at @src/price.js and more" && midOut.caret === "look at @src/price.js ".length, JSON.stringify(midOut));
  const tight = applyMention("@pri,", findTrigger("@pri,", 4)!, "a.js");
  expect(tight.text === "@a.js ,", "글이 바로 이어 붙으면 공백을 하나 넣는다");
  const newline = applyMention("see @pri\nnext", findTrigger("see @pri\nnext", 8)!, "a.js");
  expect(newline.text === "see @a.js\nnext" && newline.caret === "see @a.js".length, JSON.stringify(newline));
  expect(applyMention("@d", findTrigger("@d", 2)!, "docs/한글 문서.md").text === '@"docs/한글 문서.md" ', "공백이 든 경로는 따옴표");
  expect(findTrigger(out.text, out.text.length) === null, "고른 뒤에는 목록이 다시 열리지 않는다");
});

test("findTrigger: 문장 중간의 `/스킬` 도 목록을 열고, 경로 중간이나 두 번째 `/` 에서는 열지 않는다", () => {
  const mid = "보고서에 /writ";
  const t = findTrigger(mid, mid.length);
  expect(t?.kind === "slash" && t.query === "writ" && t.start === "보고서에 ".length && t.end === mid.length, JSON.stringify(t));
  expect(findTrigger("보고서에 /", "보고서에 /".length)?.query === "", "막 친 `/` 도 연다");
  expect(findTrigger("see src/ab", 10) === null, "경로 중간의 `/` 는 열지 않는다");
  expect(findTrigger("open /Users/ge", 14) === null, "절대 경로의 두 번째 `/` 부터는 닫힌다");
  expect(findTrigger("/rev", 4)?.start === 0, "맨 앞 `/` 는 그대로");
  expect(findTrigger("ask @a/b", 8)?.kind === "mention", "@경로 안의 `/` 는 멘션 그대로");
  const next = applyTrigger(mid, t!, "/writing ");
  expect(next.text === "보고서에 /writing " && next.caret === next.text.length, JSON.stringify(next));
});

test("removeMention: 칩으로 따로 붙는 파일은 글에서 @검색어 만 지우고 양쪽 공백이 겹치지 않게 한다", () => {
  const typed = "look at @pri and more";
  const out = removeMention(typed, findTrigger(typed, "look at @pri".length)!);
  expect(out.text === "look at and more" && out.caret === "look at ".length, JSON.stringify(out));
  const end = removeMention("look at @pri", findTrigger("look at @pri", 12)!);
  expect(end.text === "look at ", "끝이면 앞 공백만 남는다");
});

test("clipboardImageFiles 와 dragHasFiles: 글 없이 이미지만 있을 때만 이미지로 받고, 끌기는 Files 종류만 받는다", () => {
  const png = { type: "image/png", name: "a.png" };
  const txt = { type: "text/plain", name: "a.txt" };
  expect(clipboardImageFiles({ files: [png], types: ["Files"] }).length === 1, "이미지만");
  expect(clipboardImageFiles({ files: [png], types: ["text/plain", "Files"] }).length === 0, "글이 같이 있으면 글 붙여넣기가 우선");
  expect(clipboardImageFiles({ files: [txt], types: ["Files"] }).length === 0, "이미지가 아닌 파일");
  expect(clipboardImageFiles({ files: [png, txt, png], types: ["Files"] }).length === 2, "이미지만 거른다");
  expect(clipboardImageFiles(null).length === 0, "null");
  expect(dragHasFiles({ types: ["Files"] }) && !dragHasFiles({ types: ["text/plain"] }) && !dragHasFiles(null), "끌기 종류");
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
