// B3: 세션 프로세스 입력 큐와 턴 경계 판단(server/turnInput.ts), 입력창의 `/` `@` 트리거와 입력 기록(web/composerState.ts), 파일 검색 순위(web/fileSearch.ts) 단독 시험.
// 실행: npm test
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TimelineItem } from "../shared/protocol";
import { applyTrigger, findTrigger, getDraft, historyOf, HISTORY_LIMIT, setDraft, stepHistory } from "../web/composerState";
import { rankFiles } from "../web/fileSearch";
import { consumedUuids, isControlEcho, ownsTurn, PushQueue, splitSteering, turnEnd, userMessage } from "../server/turnInput";

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

test("PushQueue: 넣은 순서대로 나오고, 비어 있으면 기다렸다가 새 메시지로 깨어난다", async () => {
  const queue = new PushQueue();
  const seen: string[] = [];
  const reader = (async () => {
    for await (const m of queue) seen.push(String(m.message.content));
  })();
  queue.push(userMessage("a", "u1"));
  queue.push(userMessage("b", "u2"));
  await new Promise((r) => setTimeout(r, 10));
  expect(seen.join() === "a,b", `앞의 둘 ${seen.join()}`);
  queue.push(userMessage("c", "u3"));
  await new Promise((r) => setTimeout(r, 10));
  expect(seen.join() === "a,b,c", `기다리던 뒤에 하나 더 ${seen.join()}`);
  queue.close();
  await reader;
  expect(true, "close 하면 반복이 끝난다");
});

test("PushQueue: close 전에 쌓인 메시지는 다 내보낸 뒤 끝난다", async () => {
  const queue = new PushQueue();
  queue.push(userMessage("x", "u1"));
  queue.close();
  const seen: string[] = [];
  for await (const m of queue) seen.push(String(m.message.content));
  expect(seen.join() === "x", seen.join());
});

test("userMessage: 우리가 정한 uuid 가 그대로 들어가고, priority 는 끼어들기일 때만 붙는다", () => {
  const plain = userMessage("hi", "id-1");
  expect((plain.uuid as string) === "id-1" && !("priority" in plain) && plain.message.content === "hi" && plain.parent_tool_use_id === null, "보통 메시지");
  expect(userMessage("hi", "id-2", "now").priority === "now", "now 우선순위");
  expect(userMessage("hi", "id-3", "next").priority === "next", "next 우선순위(끼어들기는 도구가 끝난 뒤에 반영된다)");
});

test("isControlEcho: 중단 안내와 로컬 명령 출력만 걸러내고 사용자 글은 남긴다", () => {
  const user = (content: unknown) => ({ type: "user", message: { role: "user", content }, parent_tool_use_id: null }) as unknown as SDKMessage;
  expect(isControlEcho(user([{ type: "text", text: "[Request interrupted by user]" }])), "중단 블록");
  expect(isControlEcho(user("[Request interrupted by user for tool use]")), "중단 문자열");
  expect(isControlEcho(user("<local-command-stdout>Set model to sonnet</local-command-stdout>")), "모델 바꾸기 출력");
  expect(!isControlEcho(user("hello")), "일반 글");
  expect(!isControlEcho(user([{ type: "tool_result", tool_use_id: "t", content: "ok" }])), "도구 결과");
  expect(!isControlEcho({ type: "assistant", message: { content: [] } } as unknown as SDKMessage), "assistant");
});

test("turnEnd: 정상, 오류, 중단은 끝이고 큐의 다음 메시지는 정상일 때만 간다", () => {
  expect(turnEnd({ interrupted: false, isError: false }) === "ok", "정상");
  expect(turnEnd({ interrupted: false, isError: true }) === "error", "오류");
  expect(turnEnd({ interrupted: true, isError: true }) === "interrupted", "중단은 오류 result 로 와도 중단");
});

test("turnEnd: 이어질 턴이 있으면 끝이 아니다(queued_turn_count)", () => {
  expect(turnEnd({ interrupted: false, isError: false, queuedTurnCount: 1 }) === "continue", "대기 중인 턴");
  expect(turnEnd({ interrupted: true, isError: true, queuedTurnCount: 2 }) === "continue", "중단해도 CLI 쪽 대기 턴은 이어진다");
  expect(turnEnd({ interrupted: false, isError: false, queuedTurnCount: 0 }) === "ok", "0 이면 끝");
});

test("turnEnd: 끼어들기가 아직 result 에 안 담겼으면 앞 턴의 result 는 끝이 아니다(steered), uuid 목록을 모르면 끝으로 본다", () => {
  expect(turnEnd({ interrupted: false, isError: true, pendingSteers: 1, uuidsKnown: true }) === "steered", "끊긴 턴의 오류 result");
  expect(turnEnd({ interrupted: false, isError: false, pendingSteers: 1, uuidsKnown: true }) === "steered", "마무리된 앞 턴의 result");
  expect(turnEnd({ interrupted: false, isError: false, pendingSteers: 0, uuidsKnown: true }) === "ok", "끼어들기를 담은 result 는 끝");
  expect(turnEnd({ interrupted: false, isError: false, pendingSteers: 1, uuidsKnown: false }) === "ok", "옛 CLI");
  expect(turnEnd({ interrupted: true, isError: true, pendingSteers: 1, uuidsKnown: true }) === "interrupted", "중단이 우선");
});

test("ownsTurn: 턴을 시작한 메시지 uuid 가 result 에 담겼을 때만, 목록이 없으면 그렇다고 본다", () => {
  expect(ownsTurn("a", ["x", "a"]), "담김");
  expect(!ownsTurn("a", ["x"]), "다른 메시지의 result");
  expect(ownsTurn("a", undefined), "옛 CLI");
  expect(!ownsTurn(null, ["a"]), "CLI 가 스스로 연 턴");
});

test("findTrigger: 슬래시는 입력 맨 앞이나 공백 뒤에서, 멘션은 줄 앞이나 공백 뒤에서만", () => {
  expect(JSON.stringify(findTrigger("/re", 3)) === JSON.stringify({ kind: "slash", query: "re", start: 0, end: 3 }), "슬래시");
  expect(findTrigger("/rename 새 이름", 12) === null, "슬래시 뒤에 공백이 있으면 닫힌다");
  expect(JSON.stringify(findTrigger("see /re", 7)) === JSON.stringify({ kind: "slash", query: "re", start: 4, end: 7 }), "문장 중간 슬래시도 스킬 목록을 연다");
  expect(findTrigger("see a/re", 8) === null, "단어 중간의 슬래시는 아니다");
  expect(findTrigger("/tmp/foo.ts", 11)?.kind === "slash", "경로로 시작해도 트리거(빈 결과면 메뉴가 안 뜬다)");
  const mention = findTrigger("look at @src/ap", 15);
  expect(mention?.kind === "mention" && mention.query === "src/ap" && mention.start === 8, "멘션");
  expect(findTrigger("mail me@x.com", 13) === null, "단어 중간의 @ 는 멘션이 아니다");
  expect(findTrigger("@a b", 4) === null, "공백 뒤는 닫힌다");
  expect(findTrigger("hello", 5) === null, "트리거 없음");
});

test("applyTrigger: 트리거 글자를 고른 것으로 바꾸고 커서는 그 바로 뒤", () => {
  const trigger = findTrigger("fix @ap please", 7)!;
  const next = applyTrigger("fix @ap please", trigger, "");
  expect(next.text === "fix  please" && next.caret === 4, JSON.stringify(next));
  const slash = applyTrigger("/re", findTrigger("/re", 3)!, "/rename ");
  expect(slash.text === "/rename " && slash.caret === 8, JSON.stringify(slash));
});

test("stepHistory: 위로 가며 오래된 쪽으로, 아래로 가며 처음 상태(null)로 돌아온다", () => {
  expect(stepHistory(0, null, "up") === null, "기록이 없으면 그대로");
  expect(stepHistory(3, null, "up") === 2, "첫 위 화살표는 가장 최근");
  expect(stepHistory(3, 2, "up") === 1 && stepHistory(3, 0, "up") === 0, "맨 앞에서 멈춤");
  expect(stepHistory(3, 1, "down") === 2, "아래로");
  expect(stepHistory(3, 2, "down") === null, "끝에서 한 번 더 아래면 비워진 상태");
  expect(stepHistory(3, null, "down") === null, "넘기는 중이 아니면 그대로");
});

test("historyOf: 사용자가 보낸 글만, 오래된 것부터 최근 50개", () => {
  const items: TimelineItem[] = [
    { id: "1", kind: "user", text: "first", source: "user" },
    { id: "2", kind: "assistant", text: "answer", streaming: false },
    { id: "3", kind: "user", text: "automated", source: "system" },
    { id: "4", kind: "user", text: "second" },
  ];
  expect(historyOf(items).join() === "first,second", historyOf(items).join());
  const many: TimelineItem[] = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => ({ id: String(i), kind: "user" as const, text: `m${i}` }));
  const kept = historyOf(many);
  expect(kept.length === HISTORY_LIMIT && kept[0] === "m5" && kept.at(-1) === `m${HISTORY_LIMIT + 4}`, `${kept.length} ${kept[0]}`);
  expect(historyOf(undefined).length === 0, "타임라인이 아직 없음");
});

test("초안: 세션마다 따로 남고, 빈 글이면 지워진다", () => {
  setDraft("agent-1", "draft text");
  setDraft("new:pane-1", "other");
  expect(getDraft("agent-1") === "draft text" && getDraft("new:pane-1") === "other", "따로 보관");
  setDraft("agent-1", "");
  expect(getDraft("agent-1") === "" && getDraft("new:pane-1") === "other", "비우면 지워짐");
});

test("rankFiles: 파일 이름 일치가 경로 일치보다 앞이고 글자는 순서만 맞으면 된다", () => {
  const files = ["docs/guide.md", "src/a/Composer.tsx", "src/Composer.test.ts", "web/Composer.tsx", "README.md"];
  const ranked = rankFiles(files, "composer.tsx");
  expect(ranked[0] === "web/Composer.tsx" || ranked[0] === "src/a/Composer.tsx", ranked.join());
  expect(rankFiles(files, "rdm")[0] === "README.md", "부분 수열");
  expect(rankFiles(files, "").length === files.length, "빈 검색은 앞에서부터");
  expect(rankFiles(files, "zzz").length === 0, "없음");
  expect(rankFiles(files, "composer", 2).length === 2, "한도");
});

test("끼어들기 대기: 모델이 받은 메시지(uuid 가 응답 조각에 든 것)만 대화로 옮기고 나머지는 계속 기다린다", () => {
  const steering = [
    { id: "s1", text: "first" },
    { id: "s2", text: "second" },
  ];
  const none = splitSteering(steering, ["turn-prompt"]);
  expect(none.taken.length === 0 && none.rest.length === 2, "받지 않은 동안은 그대로");
  const one = splitSteering(steering, ["turn-prompt", "s1"]);
  expect(one.taken.map((s) => s.text).join() === "first" && one.rest.map((s) => s.id).join() === "s2", "첫 메시지만 옮김");
  expect(splitSteering(undefined, ["s1"]).taken.length === 0, "대기 목록이 없으면 아무 일 없음");
  expect(splitSteering(steering, undefined).rest.length === 2, "uuid 를 안 주는 조각(옛 CLI)은 건드리지 않는다");
  expect(consumedUuids({ user_message_uuids: ["a", "b"], user_message_uuid: "b" })?.join() === "a,b", "목록이 있으면 목록");
  expect(consumedUuids({ user_message_uuid: "c" })?.join() === "c", "단일 uuid 만 오는 옛 형식");
  expect(consumedUuids({}) === undefined, "둘 다 없으면 없음");
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
