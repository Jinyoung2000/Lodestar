import { CODEX_FALLBACK_MODE, CODEX_MODE_NOTES, codexPermission, codexSupportsMode } from "../shared/codexPermission";
import { CLAUDE_EFFORT_LEVELS, claudeEffort, EFFORT_LEVELS, harnessOf, isEffortLevel, PERMISSION_MODE_VALUES, type Agent, type TimelineItem } from "../shared/protocol";
import { CARRY_MAX_CHARS, carryAfterCut, carryTranscript, checkpointLocked, harnessAtStart, remapSeen, switchBlock, switchedState } from "../shared/harnessSwitch";
import { toolChanges } from "../web/timelineModel";
import { previewEdit } from "../web/approvalPreview";
import { commandApproval, diffHunks, displayCommand, editToolOf, fileChangeApproval, itemToTimeline, mcpResultText, planToTool, summarizeDiff, turnErrorOf } from "../server/codex/mapping";
import { taskState } from "../shared/tasks";
import { chooseOption, commandOutput, modelChoice, parseAgyModels, toolOf } from "../server/antigravity/mapping";
import { antigravityApprovesAll, antigravityMode } from "../shared/antigravityPermission";

const cases: { name: string; run: () => void }[] = [];
const test = (name: string, run: () => void) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const ctx = { cwd: "/repo" };
const tool = (items: TimelineItem[], index = 0) => {
  const item = items[index];
  if (item?.kind !== "tool") throw new Error(`도구 항목이 아니다: ${JSON.stringify(item)}`);
  return item;
};

test("명령 실행: 셸 래퍼를 벗기고 Bash 도구 항목으로, 출력과 종료 코드가 상태가 된다", () => {
  expect(displayCommand(`/bin/zsh -lc "git status"`) === "git status", "큰따옴표 래퍼");
  expect(displayCommand(`bash -lc 'echo "hi"'`) === `echo "hi"`, "작은따옴표 래퍼");
  expect(displayCommand("ls -la") === "ls -la", "래퍼 없는 명령은 그대로");
  const running = tool(itemToTimeline({ type: "commandExecution", id: "c1", command: "/bin/zsh -lc \"ls\"", cwd: "/repo", status: "inProgress", aggregatedOutput: null, exitCode: null }, "started", ctx));
  expect(running.name === "Bash" && running.input.command === "ls" && running.status === "running" && running.output === null, `시작 ${JSON.stringify(running)}`);
  const done = tool(itemToTimeline({ type: "commandExecution", id: "c1", command: "ls", cwd: "/repo", status: "completed", aggregatedOutput: "a.txt\n", exitCode: 0 }, "completed", ctx));
  expect(done.status === "done" && done.output === "a.txt\n", "정상 종료");
  const failed = tool(itemToTimeline({ type: "commandExecution", id: "c2", command: "false", cwd: "/repo", status: "completed", aggregatedOutput: "", exitCode: 1 }, "completed", ctx));
  expect(failed.status === "error" && failed.output === "Exit code 1", `비정상 종료 ${JSON.stringify(failed)}`);
  const declined = tool(itemToTimeline({ type: "commandExecution", id: "c3", command: "rm x", cwd: "/repo", status: "declined", aggregatedOutput: null, exitCode: null }, "completed", ctx));
  expect(declined.status === "error" && declined.cancelled === true, "거절은 취소로");
});

test("파일 변경: add 는 Write, update 는 hunk 수에 따라 Edit 또는 MultiEdit, delete 는 Edit", () => {
  const add = editToolOf({ path: "a.txt", kind: { type: "add" }, diff: "one\ntwo\n" }, "/repo");
  expect(add.name === "Write" && add.input.file_path === "/repo/a.txt" && add.input.content === "one\ntwo\n", `add ${JSON.stringify(add)}`);
  const update = editToolOf({ path: "src/b.ts", kind: { type: "update", move_path: null }, diff: "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n" }, "/repo");
  expect(update.name === "Edit" && update.input.old_string === "keep\nold\n" && update.input.new_string === "keep\nnew\nextra\n", `update ${JSON.stringify(update)}`);
  const multi = editToolOf({ path: "c.ts", kind: { type: "update", move_path: null }, diff: "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -9,1 +9,1 @@\n-x\n+y\n" }, "/repo");
  expect(multi.name === "MultiEdit" && Array.isArray(multi.input.edits) && (multi.input.edits as unknown[]).length === 2, "hunk 둘은 MultiEdit");
  const del = editToolOf({ path: "d.txt", kind: { type: "delete" }, diff: "bye\n" }, "/repo");
  expect(del.name === "Edit" && del.input.new_string === "" && del.input.old_string === "bye\n", "delete");
  expect(diffHunks("no hunks here").length === 0, "hunk 없는 글은 빈 목록");
  const moved = editToolOf({ path: "e.ts", kind: { type: "update", move_path: "f.ts" }, diff: "@@ -1 +1 @@\n-a\n+b\n" }, "/repo");
  expect(moved.input.moved_to === "/repo/f.ts", "이름 변경은 moved_to");
});

test("파일 변경 항목: 파일이 여럿이면 파일마다 도구 항목이고 id 는 항목 id 에 번호를 붙인다. 기존 변경량 계산이 그대로 읽는다", () => {
  const item = { type: "fileChange", id: "p1", status: "completed", changes: [{ path: "a.txt", kind: { type: "add" }, diff: "x\ny\n" }, { path: "b.ts", kind: { type: "update", move_path: null }, diff: "@@ -1,2 +1,2 @@\n keep\n-old\n+new\n" }] };
  const items = itemToTimeline(item, "completed", ctx);
  expect(items.length === 2 && items[0].id === "p1:0" && items[1].id === "p1:1", `id ${items.map((i) => i.id)}`);
  const a = tool(items, 0);
  const b = tool(items, 1);
  expect(a.name === "Write" && JSON.stringify(toolChanges(a.name, a.input)) === JSON.stringify({ additions: 2, deletions: 0 }), `Write 변경량 ${JSON.stringify(toolChanges(a.name, a.input))}`);
  const countB = toolChanges(b.name, b.input);
  expect(countB?.additions === 1 && countB.deletions === 1, `Edit 변경량 ${JSON.stringify(countB)}`);
  const single = itemToTimeline({ type: "fileChange", id: "p2", status: "inProgress", changes: [{ path: "a.txt", kind: { type: "add" }, diff: "x" }] }, "started", ctx);
  expect(single.length === 1 && single[0].id === "p2" && tool(single).status === "running", "하나면 항목 id 그대로");
  expect(tool(itemToTimeline({ ...item, status: "failed" }, "completed", ctx)).status === "error", "실패");
});

test("파일 변경 승인: 카드는 첫 파일의 Edit 입력을 갖고 나머지 파일은 입력에 적히며, 미리보기가 현재 파일에 변경을 적용한다", () => {
  const started = { type: "fileChange", id: "p3", changes: [{ path: "n.txt", kind: { type: "update", move_path: null }, diff: "@@ -1,1 +1,2 @@\n existing line\n+added by codex\n" }, { path: "m.txt", kind: { type: "add" }, diff: "m" }] };
  const card = fileChangeApproval(7, { itemId: "p3", reason: null }, started, "/repo");
  expect(card.kind === "permission" && card.id === "codex-approval:7" && card.toolUseId === "p3:0" && card.toolName === "Edit" && card.status === "pending", JSON.stringify(card));
  expect(JSON.stringify(card.input.other_files) === JSON.stringify(["/repo/m.txt"]), "나머지 파일");
  const preview = previewEdit(card.toolName, card.input, "existing line\ntail\n");
  expect(preview?.after === "existing line\nadded by codex\ntail\n" && preview.before === "existing line\ntail\n", `미리보기 ${JSON.stringify(preview)}`);
});

test("명령 승인 카드: Bash 도구로, 이유와 작업 폴더는 입력에 둔다", () => {
  const card = commandApproval(3, { command: `/bin/zsh -lc "npm test"`, reason: "needs network", cwd: "/repo" }, "c9");
  expect(card.toolName === "Bash" && card.toolUseId === "c9" && card.input.command === "npm test" && card.input.description === "needs network" && card.input.cwd === "/repo", JSON.stringify(card));
});

test("MCP 호출, 웹 검색, 이미지 보기, 추론, 어시스턴트 글, 컨텍스트 압축", () => {
  const mcp = tool(itemToTimeline({ type: "mcpToolCall", id: "m1", server: "docs", tool: "search", arguments: { query: "x" }, status: "completed", result: { content: [{ type: "text", text: "hit" }] }, error: null }, "completed", ctx));
  expect(mcp.name === "mcp__docs__search" && mcp.input.query === "x" && mcp.output === "hit" && mcp.status === "done", JSON.stringify(mcp));
  expect(mcpResultText(null, { message: "boom" }) === "boom", "MCP 오류 문구");
  expect(tool(itemToTimeline({ type: "mcpToolCall", id: "m2", server: "s", tool: "t", arguments: {}, status: "failed", result: null, error: { message: "boom" } }, "completed", ctx)).status === "error", "MCP 실패");
  const web = tool(itemToTimeline({ type: "webSearch", id: "w1", query: "", action: { type: "search", query: "relay hooks", queries: null } }, "completed", ctx));
  expect(web.name === "WebSearch" && web.input.query === "relay hooks", "웹 검색");
  expect(tool(itemToTimeline({ type: "imageView", id: "i1", path: "shot.png" }, "completed", ctx)).input.file_path === "/repo/shot.png", "이미지 보기는 Read");
  const thinking = itemToTimeline({ type: "reasoning", id: "r1", summary: ["first", "second"], content: [] }, "completed", ctx)[0];
  expect(thinking.kind === "thinking" && thinking.text === "first\n\nsecond", "추론 요약");
  expect(itemToTimeline({ type: "reasoning", id: "r2", summary: [], content: [] }, "completed", ctx).length === 0, "빈 추론은 그리지 않는다");
  const live = itemToTimeline({ type: "agentMessage", id: "a1", text: "" }, "started", ctx);
  expect(live.length === 0, "빈 시작 글은 델타가 올 때 만든다");
  const final = itemToTimeline({ type: "agentMessage", id: "a1", text: "done" }, "completed", ctx)[0];
  expect(final.kind === "assistant" && final.text === "done" && final.streaming === false, "확정 글");
  expect(itemToTimeline({ type: "userMessage", id: "u1", content: [] }, "completed", ctx).length === 0, "사용자 메시지는 이미 넣었다");
  expect(itemToTimeline({ type: "somethingNew", id: "z" }, "completed", ctx).length === 0, "모르는 항목은 무시");
  expect(itemToTimeline({ type: "contextCompaction", id: "k" }, "completed", ctx)[0]?.kind === "notice", "압축 알림");
});

test("계획 갱신: 기존 TodoWrite 항목이 되고 할 일 표시가 그대로 읽는다", () => {
  const todo = planToTool("t1", [{ step: "Read", status: "completed" }, { step: "Edit", status: "inProgress" }, { step: "Test", status: "pending" }]);
  expect(todo.name === "TodoWrite" && todo.id === "plan:t1", "이름과 id");
  const state = taskState([todo]);
  expect(state.total === 3 && state.done === 1 && state.current?.subject === "Edit", JSON.stringify(state));
});

test("턴 diff 요약: 파일 수와 추가, 삭제 줄을 센다", () => {
  const diff = "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1,2 @@\n a\n+b\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n";
  const summary = summarizeDiff(diff, "/repo");
  expect(summary?.files === 3 && summary.additions === 2 && summary.deletions === 1, JSON.stringify(summary));
  expect(summary?.list?.[0].path === "/repo/x.txt" && summary.list[2].path === "/repo/gone.txt", "경로는 절대 경로");
  expect(summarizeDiff("", "/repo") === undefined, "빈 diff");
});

test("턴 오류: 인증 문제는 auth 로 표시한다", () => {
  expect(turnErrorOf({ message: "boom", codexErrorInfo: "other" }).auth === false, "일반 오류");
  expect(turnErrorOf({ message: "Please log in", codexErrorInfo: null }).auth === true, "로그인 문구");
  expect(turnErrorOf({ message: "x", codexErrorInfo: "unauthorized" }).auth === true, "unauthorized");
  expect(turnErrorOf(null).text.length > 0, "오류 정보가 없어도 문구가 있다");
  const api = turnErrorOf({ message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}' });
  expect(api.text === "The model is not supported when using Codex with a ChatGPT account.", `API 오류 JSON 은 안쪽 문구만 ${api.text}`);
});

test("권한 모드 표: plan 만 없고, 나머지는 승인 정책과 샌드박스가 스키마 값이다", () => {
  expect(PERMISSION_MODE_VALUES.filter((m) => !codexSupportsMode(m)).join() === "plan", "plan 만 없다");
  const d = codexPermission("default")!;
  expect(d.approvalPolicy === "untrusted" && d.sandbox === "workspace-write" && d.sandboxPolicy.type === "workspaceWrite" && d.approvalsReviewer === "user", "default");
  const e = codexPermission("acceptEdits")!;
  expect(e.approvalPolicy === "on-request" && e.sandbox === "workspace-write", "acceptEdits");
  const a = codexPermission("auto")!;
  expect(a.approvalPolicy === "on-request" && a.approvalsReviewer === "auto_review", "auto");
  const b = codexPermission("bypassPermissions")!;
  expect(b.approvalPolicy === "never" && b.sandbox === "danger-full-access" && b.sandboxPolicy.type === "dangerFullAccess", "bypass");
  expect(codexSupportsMode(CODEX_FALLBACK_MODE), "대체 모드는 쓸 수 있다");
  expect(PERMISSION_MODE_VALUES.every((m) => CODEX_MODE_NOTES[m].length > 0), "모드마다 설명이 있다");
});

test("옛 저장본 호환: harness 가 없는 세션은 claude 이고, 새 필드는 JSON 으로 저장해도 옛 필드를 건드리지 않는다", () => {
  const old = { id: "a", workspaceId: "w", cwd: "/x", worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: "t", sessionId: "s1", status: "idle", permissionMode: "default", model: null, effort: null, activeModel: null, activeEffort: null, backgroundTasks: 0, createdAt: "", updatedAt: "" } as Agent;
  expect(harnessOf(old) === "claude" && !("harness" in old), "필드 없음 = claude");
  const codex = { ...old, harness: "codex" as const, codexThreadId: "th-1", sessionId: null };
  const round = JSON.parse(JSON.stringify(codex)) as Agent;
  expect(harnessOf(round) === "codex" && round.codexThreadId === "th-1", "저장 후에도 유지");
  const keys = Object.keys(old);
  expect(keys.every((k) => k in round), "옛 필드가 모두 남아 있다");
});

const switched: TimelineItem[] = [
  { id: "u1", kind: "user", text: "fix the bug", source: "user", messageId: "m1" },
  { id: "a1", kind: "assistant", text: "Fixed it in Claude", streaming: false },
  { id: "r1", kind: "result", isError: false, durationMs: 1, costUsd: null, changes: { files: 1, additions: 3, deletions: 1, list: [{ path: "/repo/src/a.ts", additions: 3, deletions: 1 }] } },
  { id: "d1", kind: "notice", text: "Switched to Codex · gpt-x", divider: true, switched: "codex" },
  { id: "u2", kind: "user", text: "<earlier-conversation>old</earlier-conversation>\n\ncontinue", shown: "continue", source: "user" },
  { id: "t1", kind: "tool", name: "Bash", input: { command: "ls" }, status: "done", output: "a.ts" },
  { id: "k1", kind: "thinking", text: "hmm" },
  { id: "a2", kind: "assistant", text: "Codex reply", streaming: false },
  { id: "r2", kind: "result", isError: false, durationMs: 1, costUsd: null, changes: { files: 2, additions: 3, deletions: 1, list: [{ path: "/repo/src/a.ts", additions: 2, deletions: 0 }, { path: "/repo/b.ts", additions: 1, deletions: 1 }] } },
  { id: "d2", kind: "notice", text: "Switched to Claude · opus", divider: true, switched: "claude" },
];
const carryAgent = (patch: Partial<Agent>) => ({ harness: "claude" as const, sessionId: null, resumeFrom: null, codexThreadId: null, seenThrough: undefined, cwd: "/repo", ...patch });

test("넘겨받기: 새 Codex 스레드는 처음부터의 대화를 받고, 도구 소음과 말풍선에 안 보인 글은 빠진다", () => {
  const text = carryTranscript(switched.slice(0, 4), carryAgent({ harness: "codex", codexThreadId: null, seenThrough: { claude: "d1" } }))!;
  expect(text.startsWith("<earlier-conversation>\n") && text.endsWith("\n</earlier-conversation>"), "구분 블록");
  expect(text.includes("You are Codex."), "받는 도구 이름");
  expect(text.includes("User:\nfix the bug\n\nClaude:\nFixed it in Claude\n\nFiles changed in these turns:\n- src/a.ts (+3 -1)"), text);
});

test("넘겨받기: Claude 로 돌아가면 Claude 가 마지막으로 본 지점 뒤의 Codex 턴만 받는다", () => {
  const text = carryTranscript(switched, carryAgent({ sessionId: "s1", seenThrough: { claude: "d1", codex: "d2" } }))!;
  expect(text.includes("User:\ncontinue\n\nCodex:\nCodex reply\n\nFiles changed in these turns:\n- src/a.ts (+2 -0)\n- b.ts (+1 -1)"), text);
  expect(!text.includes("fix the bug") && !text.includes(">old<") && !text.includes("Bash") && !text.includes("hmm"), "본 턴, 넘겨받은 글, 도구, 생각은 없다");
  expect(text.includes("You are Claude."), "받는 도구 이름");
  expect(carryTranscript(switched, carryAgent({ sessionId: "s1", seenThrough: { claude: "gone" } })) === null, "표지가 없으면 보내지 않는다");
  expect(carryTranscript(switched, carryAgent({ sessionId: "s1", seenThrough: { claude: "d2" } })) === null, "새 턴이 없으면 null");
});

test("넘겨받기: 크기 한도를 넘으면 오래된 메시지부터 빼고 표시를 남기며, 긴 메시지는 가운데를 줄인다", () => {
  const many: TimelineItem[] = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, kind: "assistant" as const, text: `${i}:${"x".repeat(4000)}`, streaming: false }));
  const text = carryTranscript([...many, { id: "big", kind: "user", text: "y".repeat(20_000), source: "user" }], carryAgent({ harness: "codex" }))!;
  expect(text.length <= CARRY_MAX_CHARS, `길이 ${text.length}`);
  expect(/\[\d+ earlier messages omitted to keep this short\]/.test(text) && !text.includes("Codex:\n0:") && text.includes("Codex:\n29:"), "오래된 것부터 뺀다");
  expect(text.includes("[... 12000 characters omitted ...]"), "긴 메시지는 가운데를 줄인다");
});

test("본 범위 기록: 바꿀 때 떠나는 도구의 표지를 나눔 줄로 옮기고, 되돌리기와 갈래는 넘겨받기를 다시 건다", () => {
  expect(JSON.stringify(switchedState({ harness: "codex", seenThrough: { claude: "d1" } }, "d2")) === JSON.stringify({ seenThrough: { claude: "d1", codex: "d2" }, carryPending: true }), "떠나는 도구");
  const withCarry: TimelineItem[] = [...switched, { id: "u3", kind: "user", text: "next", source: "user", messageId: "m3" }];
  expect(JSON.stringify(carryAfterCut(switched, { claude: "x", codex: "d2" })) === JSON.stringify({ carryPending: true, seenThrough: { codex: "d2", claude: "d1" } }), "넘겨받은 턴을 되돌리면 다시 받는다");
  expect(JSON.stringify(carryAfterCut(withCarry, { claude: "x" })) === JSON.stringify({ carryPending: false }), "넘겨받은 턴이 남으면 끝난 것");
  expect(JSON.stringify(carryAfterCut(switched.slice(0, 3), { claude: "x" })) === "{}", "나눔 줄이 없으면 그대로");
  expect(JSON.stringify(carryAfterCut(switched.slice(4), { claude: "x" })) === JSON.stringify({ carryPending: true, seenThrough: {} }), "Claude 가 처음이면 표지를 지운다");
  expect([...checkpointLocked(withCarry, "claude")].join() === "u1,u2", "마지막으로 Claude 로 바꾸기 전 메시지는 잠긴다");
  expect([...checkpointLocked(withCarry, "codex")].join() === "u1,u2,u3", "Codex 동안은 모두 잠긴다");
  expect(checkpointLocked(switched.slice(0, 3), "claude").size === 0, "바꾼 적 없으면 잠그지 않는다");
  expect(JSON.stringify(remapSeen({ claude: "d1" }, (id) => `ab:${id}`)) === JSON.stringify({ claude: "ab:d1" }) && remapSeen(undefined, (id) => id) === undefined, "갈래의 새 id");
});

test("도구 바꾸기를 막는 경우", () => {
  const base = { status: "idle" as const, backgroundTasks: 0, feedbackId: null, imported: undefined };
  expect(switchBlock(base, switched) === null, "쉬는 세션");
  expect(switchBlock({ ...base, status: "running" }, []) === "running", "응답 중");
  expect(switchBlock({ ...base, backgroundTasks: 1 }, []) === "background", "백그라운드 작업");
  expect(switchBlock(base, [{ id: "p", kind: "permission", toolName: "Bash", input: {}, status: "pending" }]) === "waiting", "승인 대기");
  expect(switchBlock({ ...base, feedbackId: "f" }, []) === "feedback", "개선 세션");
  expect(switchBlock(base, [{ id: "n", kind: "user", text: "q", attachments: [{ kind: "notion", label: "Page", url: "https://notion.so/x" }] }]) === "notion", "Notion 페이지 대화");
});

test("effort: ultra 는 저장값으로 받지만 Claude 단계에는 없다", () => {
  expect(EFFORT_LEVELS.join() === "low,medium,high,xhigh,max,ultra", EFFORT_LEVELS.join());
  expect(CLAUDE_EFFORT_LEVELS.join() === "low,medium,high,xhigh,max", CLAUDE_EFFORT_LEVELS.join());
  expect(isEffortLevel("ultra") && !isEffortLevel("huge") && !isEffortLevel(null), "검증");
  expect(claudeEffort("ultra") === null && claudeEffort("max") === "max" && claudeEffort(undefined) === null, "Claude 로 갈 때");
});

test("Antigravity mapping: append writes, edits from diffs, commands, permission options, models and modes", () => {
  const append = toolOf({ toolCallId: "c1", name: "write_file", kind: "edit", args: { Append: true, Content: "x\n", Path: "/repo/n.txt" }, content: [{ type: "diff", path: "/repo/n.txt", newText: "x\n" }] }, "/repo");
  expect(JSON.stringify(append) === JSON.stringify({ name: "Edit", input: { file_path: "/repo/n.txt", old_string: "", new_string: "x\n", append: true } }), JSON.stringify(append));
  const created = toolOf({ toolCallId: "c2", name: "write_file", kind: "edit", args: { Content: "y\n", Path: "n.txt" } }, "/repo");
  expect(JSON.stringify(created) === JSON.stringify({ name: "Write", input: { file_path: "/repo/n.txt", content: "y\n" } }), JSON.stringify(created));
  const edited = toolOf({ toolCallId: "c3", kind: "edit", content: [{ type: "diff", path: "/repo/n.txt", oldText: "a\n", newText: "b\n" }] }, "/repo");
  expect(edited.name === "Edit" && edited.input.old_string === "a\n" && edited.input.new_string === "b\n", JSON.stringify(edited));
  expect(commandOutput("Created At: x\nCommand exited with code 0.\n\nCommand output:\na\r\nb\r\n") === "a\nb\n" && commandOutput("Command exited with code 0.\n\nNo output from the command.") === "", "command output");
  const options = [{ optionId: "ok", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }];
  expect(chooseOption(options, "allow") === "ok" && chooseOption(options, "allowAlways") === "ok" && chooseOption(options, "deny") === "no", "options");
  const models = parseAgyModels("gemini-4-neon-high\tGemini 4 Neon (High)\ngemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\ngemini-4-neon-low\tGemini 4 Neon (Low)\ngemini-pro-orchestrator-neon\tOrchestrator (Neon)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n");
  expect(JSON.stringify(models.map((m) => [m.value, m.displayName, m.supportedEffortLevels.join("/")])) === JSON.stringify([["gemini-4-neon", "Gemini 4 Neon", "low/high/xhigh"], ["gemini-pro-orchestrator-neon", "Orchestrator (Neon)", ""], ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)", ""]]), JSON.stringify(models));
  const config = [{ id: "model", options: [{ value: "gemini-4-neon" }] }, { id: "thought_level", options: [{ value: "low" }, { value: "high" }] }];
  expect(JSON.stringify(modelChoice("gemini-4-neon-low", null, config)) === JSON.stringify({ model: "gemini-4-neon", effort: "low" }) && modelChoice(null, "max", config).effort === null, "model choice");
  expect(PERMISSION_MODE_VALUES.map(antigravityMode).join() === "default,accept-edits,plan,auto,auto" && antigravityApprovesAll("bypassPermissions") && !antigravityApprovesAll("auto"), "modes");
  expect(harnessAtStart([{ id: "d", kind: "notice", text: "", divider: true, switched: "codex", switchedFrom: "antigravity" }], "codex") === "antigravity", "first tool from the divider");
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
