// 세션 참조(shared/sessionRef.ts) 시험: 찾기, 풀기, 모델 맥락 블록. 실행: npm test
import type { TimelineItem } from "../shared/protocol";
import { CONTEXT_CHARS, findSessionRefs, parseSessionArg, recentMessages, resolveSessionRef, sessionContextBlock, sessionRef, shortSessionId, type ContextAgent } from "../shared/sessionRef";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const A = "11111111-aaaa-4bbb-8ccc-000000000001";
const B = "11112222-aaaa-4bbb-8ccc-000000000002";
const C = "abcdef12-3456-4789-8abc-000000000003";
const D = "deadbeef-0000-4000-8000-000000000004";
const E = "feedc0de-0000-4000-8000-000000000005";
const F = "cafe0001-0000-4000-8000-000000000006";
const agent = (id: string, extra: Partial<ContextAgent> = {}): ContextAgent => ({ id, feedbackId: null, title: `title ${id.slice(0, 4)}`, status: "idle", cwd: `/work/${id.slice(0, 4)}`, ...extra });
const agents = [agent(A), agent(B), agent(C), agent(D), agent(E, { feedbackId: "fb1" }), agent(F)];

// 만들기
check("짧은 id 는 uuid 앞 8자", shortSessionId(C) === "abcdef12");
check("참조는 lodestar://session/<앞 8자>", sessionRef(C) === "lodestar://session/abcdef12");

// 찾기
check("두 스킴 모두 읽는다", same(findSessionRefs("see lodestar://session/abcdef12 and agent-nav://session/deadbeef"), ["abcdef12", "deadbeef"]));
check("전체 uuid 도 읽는다", same(findSessionRefs(`agent-nav://session/${C}`), [C]));
check("대문자는 소문자로 맞춘다", same(findSessionRefs("LODESTAR://SESSION/ABCDEF12"), ["abcdef12"]));
check("앞부분 6자 이상만 참조", same(findSessionRefs("lodestar://session/abcde lodestar://session/abcdef"), ["abcdef"]));
check("중복은 한 번, 순서는 처음 나온 대로", same(findSessionRefs("lodestar://session/deadbeef x lodestar://session/abcdef12 y lodestar://session/deadbeef"), ["deadbeef", "abcdef12"]));
check("마침표, 괄호, 백틱으로 끝나도 id 만 뽑는다", same(findSessionRefs("(lodestar://session/abcdef12). `lodestar://session/deadbeef`, lodestar://session/cafe0001."), ["abcdef12", "deadbeef", "cafe0001"]));
check("스킴 없는 id 와 다른 스킴은 무시", same(findSessionRefs("abcdef12 https://example.com/session/abcdef12"), []));
check("parseSessionArg: 링크, uuid, 앞부분", parseSessionArg("lodestar://session/abcdef12") === "abcdef12" && parseSessionArg(C) === C && parseSessionArg(" ABCDEF ") === "abcdef");
check("parseSessionArg: 짧거나 hex 가 아니면 null", parseSessionArg("abc") === null && parseSessionArg("zzzzzz") === null && parseSessionArg("") === null);

// 풀기
const found = (r: ReturnType<typeof resolveSessionRef>) => (r.kind === "found" ? r.agent.id : r.kind);
check("유일한 앞부분은 찾는다", found(resolveSessionRef("abcdef12", agents)) === C && found(resolveSessionRef("lodestar://session/deadbe", agents)) === D);
check("전체 uuid 로 찾는다", found(resolveSessionRef(B, agents)) === B);
const ambiguous = resolveSessionRef("1111", agents);
check("4자 앞부분은 너무 짧아 못 찾는다", ambiguous.kind === "notFound");
const amb = resolveSessionRef("111122", agents);
check("6자 앞부분이 하나만 맞으면 찾는다", found(amb) === B);
const twin = [agent("aaaaaa01-0000-4000-8000-000000000001"), agent("aaaaaa02-0000-4000-8000-000000000002")];
const twinResult = resolveSessionRef("aaaaaa", twin);
check("여러 개와 맞으면 ambiguous 와 후보", twinResult.kind === "ambiguous" && twinResult.candidates.length === 2);
check("없으면 notFound", resolveSessionRef("999999", agents).kind === "notFound");
check("피드백 개선 세션은 풀리지 않는다", resolveSessionRef("feedc0de", agents).kind === "notFound" && resolveSessionRef(E, agents).kind === "notFound");
check("피드백 세션은 앞부분 겹침 판정에도 안 센다", found(resolveSessionRef("feedc0", [...agents, agent("feedc0de-9999-4000-8000-000000000009", { feedbackId: "fb2" })])) === "notFound");

// 맥락 블록
const user = (text: string, extra: Partial<Extract<TimelineItem, { kind: "user" }>> = {}): TimelineItem => ({ id: `u${text}`, kind: "user", text, ...extra });
const assistant = (text: string, streaming = false): TimelineItem => ({ id: `a${text}`, kind: "assistant", text, streaming });
const timelines: Record<string, TimelineItem[]> = {
  [C]: [user("q1"), assistant("a1"), user("sys", { source: "system" }), user("model text", { shown: "visible text" }), assistant("partial", true), assistant("a2"), user("q3"), assistant("a3"), user("q4"), assistant("a4")],
  [D]: [user("d question"), assistant("d answer")],
  [B]: [],
};
const timelineOf = (id: string) => timelines[id] ?? [];
const block = (text: string, self = A) => sessionContextBlock(text, self, agents, timelineOf);

check("참조가 없으면 null", block("hello") === null);
const one = block("look at lodestar://session/abcdef12 please")!;
check("제목, 상태, 폴더, 참조가 들어간다", one.includes("lodestar://session/abcdef12") && one.includes("Title: title abcd") && one.includes("Status: idle") && one.includes("Workspace: /work/abcd"));
check("최근 6개: 시스템 메시지와 스트리밍 중인 응답은 빼고 오래된 것부터 잘린다", !one.includes("User: q1") && !one.includes("sys") && !one.includes("partial") && one.includes("User: visible text") && one.includes("Assistant: a4"));
check("사용자 메시지는 shown 을 쓴다", one.includes("visible text") && !one.includes("model text"));
check("CLI 안내 한 줄", one.includes("lodestar session show abcdef12 --last 30") && one.includes('lodestar session send abcdef12 "..."'));
check("자기 자신을 가리키는 참조는 건너뛴다", block("lodestar://session/abcdef12", C) === null);
check("자기 참조만 빼고 나머지는 붙인다", (block("lodestar://session/abcdef12 lodestar://session/deadbeef", C) ?? "").includes("d answer"));
const none = block("lodestar://session/999999")!;
check("못 찾은 참조는 한 줄 안내", none.includes("lodestar://session/999999: no session with this id was found."));
check("피드백 세션 참조도 못 찾은 것으로 안내", block("lodestar://session/feedc0de")!.includes("no session with this id was found"));
const amb2 = sessionContextBlock("lodestar://session/aaaaaa", A, twin, timelineOf)!;
check("모호한 참조는 후보를 알린다", amb2.includes("aaaaaa01") && amb2.includes("aaaaaa02") && amb2.includes("could not be resolved"));
const many = block("lodestar://session/abcdef12 lodestar://session/deadbeef lodestar://session/cafe0001 lodestar://session/11112222")!;
check("참조는 3개까지만 푼다", many.includes("Title: title abcd") && many.includes("Title: title dead") && many.includes("Title: title cafe") && !many.includes("Title: title 1111"));
check("자기 참조는 3개 한도에 안 센다", (block("lodestar://session/11111111 lodestar://session/abcdef12 lodestar://session/deadbeef lodestar://session/cafe0001")!.match(/^Title:/gm) ?? []).length === 3);
check("같은 세션을 짧은 id 와 uuid 로 두 번 써도 한 번만", (block(`lodestar://session/abcdef12 agent-nav://session/${C}`)!.match(/^Title:/gm) ?? []).length === 1);
check("메시지가 없는 세션", block("lodestar://session/11112222")!.includes("No messages yet."));

// 글자 수 제한
const long: TimelineItem[] = [assistant("OLD".repeat(3000)), assistant("x".repeat(5000)), user("NEWEST")];
const clipped = recentMessages(long);
check("세션당 맥락은 CONTEXT_CHARS 안(말줄임 3자 포함)", clipped.length <= CONTEXT_CHARS + 3, String(clipped.length));
check("넘치면 오래된 쪽을 자르고 최신을 남긴다", clipped.startsWith("...") && clipped.endsWith("User: NEWEST") && !clipped.includes("OLD"));
check("안 넘치면 그대로", recentMessages([user("hi"), assistant("yo")]) === "User: hi\n\nAssistant: yo");

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
