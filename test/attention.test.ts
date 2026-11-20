// 사람이 봐야 하는 세션의 수와 목록(Dock 배지, 제목줄 칩). 실행: npm test
import { attentionCount, attentionItems, awayItems, isSessionShown } from "../shared/attention";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

type A = { id: string; title: string; status: "idle" | "running" | "waiting" | "error"; done?: boolean; updatedAt: string };
const agent = (id: string, status: A["status"], patch: Partial<A> = {}): A => ({ id, title: `t-${id}`, status, updatedAt: `2026-10-16T00:00:0${id.length}Z`, ...patch });
const ids = (items: { agentId: string }[]) => items.map((i) => i.agentId).join(",");

const agents = [agent("a", "waiting", { updatedAt: "2026-10-16T01:00:00Z" }), agent("b", "running"), agent("c", "idle"), agent("d", "error"), agent("e", "waiting", { updatedAt: "2026-10-16T00:00:00Z" }), agent("f", "waiting", { done: true })];
check("only waiting sessions count, not running, idle, error or archived", attentionCount(agents, {}) === 2, ids(attentionItems(agents, {})));
check("the oldest waiting session comes first", ids(attentionItems(agents, {})) === "e,a");
check("all reasons are input for waiting sessions", attentionItems(agents, {}).every((i) => i.reason === "input"));

const feedbacks = { x: { agentId: "c", status: "needsInput" as const }, y: { agentId: "a", status: "needsInput" as const }, z: { agentId: "gone", status: "needsInput" as const }, w: { agentId: "b", status: "applied" as const } };
const withReplies = attentionItems(agents, feedbacks);
check("an improvement waiting for a reply is added once, after the waiting sessions", ids(withReplies) === "e,a,c" && withReplies[2].reason === "reply", ids(withReplies));
check("a feedback whose session is gone or that is not needsInput is not counted", attentionCount(agents, feedbacks) === 3);
check("a session already counted as waiting is not counted twice for its feedback", withReplies.filter((i) => i.agentId === "a").length === 1);

const items = attentionItems(agents, {});
const panes = [{ kind: "agent", agentId: "e" }, { kind: "draft" }];
check("sessions shown in a pane are not away", ids(awayItems(items, panes, "sessions")) === "a");
check("when Board covers the sessions nothing is visible, so everything is away", ids(awayItems(items, panes, "board")) === "e,a");
check("with no panes everything is away", ids(awayItems(items, [], "sessions")) === "e,a");

check("isSessionShown follows the panes and the center view", isSessionShown("e", panes, "sessions") && !isSessionShown("a", panes, "sessions") && !isSessionShown("e", panes, "inbox"));

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
