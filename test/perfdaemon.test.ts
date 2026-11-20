// PERFDAEMON: 스트리밍 초안 묶기(server/eventCoalescer.ts)와 state.json, 타임라인 저장 묶기(server/store.ts) 시험. 데몬도 모델도 필요 없다.
// 실행: npm test
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, ServerEvent, TimelineItem } from "../shared/protocol";

const home = mkdtempSync(join(tmpdir(), "agent-nav-perfdaemon-"));
process.env.AGENT_NAV_HOME = home;
process.env.AGENT_NAV_SAVE_DELAY_MS = "80";
process.env.AGENT_NAV_TIMELINE_CACHE = "3";
const { createCoalescer, draftInterval } = await import("../server/eventCoalescer");
const { Store } = await import("../server/store");

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const draft = (agentId: string, text: string, id = "draft-1"): ServerEvent => ({ type: "timelineUpsert", agentId, item: { id, kind: "assistant", text, streaming: true } as TimelineItem });
const textOf = (event: ServerEvent) => (event.type === "timelineUpsert" && event.item.kind === "assistant" ? event.item.text : "");

// 가짜 시계와 타이머: 시간을 손으로 밀어서 간격을 결정적으로 시험한다.
function fakeClock() {
  let now = 1000;
  const timers: { at: number; run: () => void; id: number; live: boolean }[] = [];
  let next = 0;
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      const timer = { at: now + ms, run, id: next++, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer: unknown) => {
      (timer as { live: boolean }).live = false;
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        due.live = false;
        due.run();
      }
      now = target;
    },
  };
}

test("draftInterval: 글이 길수록 간격이 늘고 상한이 있다", () => {
  expect(draftInterval(0) === 40, `빈 글 ${draftInterval(0)}`);
  expect(draftInterval(2000) === 140, `2000자 ${draftInterval(2000)}`);
  expect(draftInterval(100000) === 200, `상한 ${draftInterval(100000)}`);
});

test("초안 갱신: 첫 갱신은 바로 가고, 간격 안의 갱신은 마지막 것만 간격이 끝날 때 간다", () => {
  const clock = fakeClock();
  const sent: ServerEvent[] = [];
  const c = createCoalescer((e) => sent.push(e), { ...clock });
  c.push(draft("a", "H"));
  expect(sent.length === 1 && textOf(sent[0]) === "H", "첫 갱신은 지연 없이");
  clock.advance(10);
  c.push(draft("a", "He"));
  clock.advance(10);
  c.push(draft("a", "Hel"));
  clock.advance(10);
  c.push(draft("a", "Hell"));
  expect(sent.length === 1, `간격 안에서는 더 안 감 ${sent.length}`);
  clock.advance(40);
  expect(sent.length === 2 && textOf(sent[1]) === "Hell", `간격이 끝나면 마지막 글만 ${sent.map(textOf).join("|")}`);
  clock.advance(500);
  expect(sent.length === 2, "밀린 것이 없으면 아무것도 안 감");
});

test("초안 갱신 596번이 일정 시간 안에서 몇 번으로 줄고, 마지막 글은 반드시 간다", () => {
  const clock = fakeClock();
  const sent: ServerEvent[] = [];
  const c = createCoalescer((e) => sent.push(e), { ...clock });
  let text = "";
  for (let i = 0; i < 596; i++) {
    text += "word ";
    c.push(draft("a", text));
    clock.advance(25);
  }
  clock.advance(1000);
  expect(sent.length < 596 / 3, `갱신 수 ${sent.length}`);
  expect(textOf(sent[sent.length - 1]) === text, "마지막 글이 누락되지 않음");
  const bytes = sent.reduce((n, e) => n + JSON.stringify(e).length, 0);
  const all = (() => {
    let t = "";
    let n = 0;
    for (let i = 0; i < 596; i++) {
      t += "word ";
      n += JSON.stringify(draft("a", t)).length;
    }
    return n;
  })();
  expect(bytes < all / 4, `보낸 양 ${bytes} / 원래 ${all}`);
});

test("다른 이벤트: 같은 세션의 밀린 초안을 먼저 보내 순서를 지킨다", () => {
  const clock = fakeClock();
  const sent: ServerEvent[] = [];
  const c = createCoalescer((e) => sent.push(e), { ...clock });
  c.push(draft("a", "x"));
  c.push(draft("a", "xy"));
  c.push({ type: "timelineUpsert", agentId: "a", item: { id: "tool-1", kind: "tool", name: "Read" } as unknown as TimelineItem });
  expect(sent.map((e) => (e.type === "timelineUpsert" ? e.item.id : e.type)).join() === "draft-1,draft-1,tool-1", `순서 ${sent.map((e) => (e.type === "timelineUpsert" ? e.item.id : e.type)).join()}`);
  expect(textOf(sent[1]) === "xy", "밀린 초안의 마지막 글이 먼저 나감");
});

test("다른 세션의 이벤트는 밀린 초안을 건드리지 않는다", () => {
  const clock = fakeClock();
  const sent: ServerEvent[] = [];
  const c = createCoalescer((e) => sent.push(e), { ...clock });
  c.push(draft("a", "x"));
  c.push(draft("a", "xy"));
  c.push({ type: "timelineUpsert", agentId: "b", item: { id: "t", kind: "user", text: "hi" } as unknown as TimelineItem });
  c.push({ type: "workspaces", workspaces: [] });
  expect(sent.length === 3 && c.pendingCount() === 1, `보낸 것 ${sent.length}, 밀린 것 ${c.pendingCount()}`);
});

test("초안 삭제: 밀린 갱신은 버리고 삭제만 나간다", () => {
  const clock = fakeClock();
  const sent: ServerEvent[] = [];
  const c = createCoalescer((e) => sent.push(e), { ...clock });
  c.push(draft("a", "x"));
  c.push(draft("a", "xy"));
  c.push({ type: "timelineRemove", agentId: "a", itemId: "draft-1" });
  clock.advance(1000);
  expect(sent.map((e) => e.type).join() === "timelineUpsert,timelineRemove", `순서 ${sent.map((e) => e.type).join()}`);
  expect(c.pendingCount() === 0 && c.slotCount() === 0, "자리도 비움");
});

test("세션이 쉬면(agent idle) 밀린 초안을 먼저 보내고 자리를 비운다", () => {
  const clock = fakeClock();
  const sent: ServerEvent[] = [];
  const c = createCoalescer((e) => sent.push(e), { ...clock });
  c.push(draft("a", "x"));
  c.push(draft("a", "xy"));
  c.push({ type: "agent", agent: { id: "a", status: "idle" } as Agent });
  expect(sent.map((e) => e.type).join() === "timelineUpsert,timelineUpsert,agent", `순서 ${sent.map((e) => e.type).join()}`);
  expect(c.slotCount() === 0, "idle 뒤에는 초안 자리가 없다");
});

test("초안이 아닌 갱신(스트리밍 끝난 항목)은 묶지 않는다", () => {
  const clock = fakeClock();
  const sent: ServerEvent[] = [];
  const c = createCoalescer((e) => sent.push(e), { ...clock });
  const final = (text: string): ServerEvent => ({ type: "timelineUpsert", agentId: "a", item: { id: "m", kind: "assistant", text, streaming: false } as TimelineItem });
  c.push(final("a"));
  c.push(final("ab"));
  expect(sent.length === 2, "끝난 항목은 그대로");
});

test("Store.save: 상태 변경 여러 번은 파일 쓰기 한 번으로 묶이고, flush 가 남은 것을 바로 쓴다", async () => {
  const store = new Store();
  await sleep(150);
  const file = join(home, "state.json");
  const agent = (id: string): Agent => ({ id, workspaceId: null, cwd: home, worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: id, sessionId: null, status: "idle", permissionMode: "default", model: null, effort: null, activeModel: null, activeEffort: null, backgroundTasks: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }) as Agent;
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  store.addAgent(agent("one"));
  store.updateAgent("one", { status: "running" });
  store.updateAgent("one", { status: "idle" });
  store.patchAgent("one", { title: "renamed" });
  expect((existsSync(file) ? readFileSync(file, "utf8") : "") === before, "지연 시간 안에는 파일이 그대로");
  await sleep(200);
  const saved = JSON.parse(readFileSync(file, "utf8")) as { agents: { id: string; title: string; status: string }[] };
  expect(saved.agents.some((a) => a.id === "one" && a.title === "renamed" && a.status === "idle"), "묶인 쓰기에 마지막 상태가 들어 있다");
  store.patchAgent("one", { title: "flushed" });
  store.flush();
  const flushed = JSON.parse(readFileSync(file, "utf8")) as { agents: { id: string; title: string }[] };
  expect(flushed.agents.find((a) => a.id === "one")?.title === "flushed", "flush 는 기다리지 않고 쓴다");
});

test("Store.upsertItem: 스트리밍 초안은 타임라인 저장을 걸지 않고, 끝난 항목은 건다", async () => {
  const store = new Store();
  const id = "tl-agent";
  const file = join(home, "timelines", `${id}.json`);
  store.upsertItem(id, { id: "d", kind: "assistant", text: "partial", streaming: true } as TimelineItem);
  store.upsertItem(id, { id: "d", kind: "assistant", text: "partial more", streaming: true } as TimelineItem);
  await sleep(700);
  expect(!existsSync(file), "초안만 있을 때는 파일을 쓰지 않는다");
  store.upsertItem(id, { id: "m", kind: "assistant", text: "done", streaming: false } as TimelineItem);
  await sleep(700);
  const saved = JSON.parse(readFileSync(file, "utf8")) as TimelineItem[];
  expect(saved.length === 1 && saved[0].id === "m", `끝난 항목만 저장 ${JSON.stringify(saved.map((i) => i.id))}`);
  store.flush();
});

test("Store.timeline: 메모리에는 상한만큼만 두고, 살아 있는 세션과 저장이 밀린 세션은 내리지 않으며, 내린 것은 다시 읽는다", async () => {
  const store = new Store();
  mkdirSync(join(home, "timelines"), { recursive: true });
  const ids = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"];
  for (const id of ids) writeFileSync(join(home, "timelines", `${id}.json`), JSON.stringify([{ id: `${id}-m`, kind: "notice", text: id }]));
  store.isLive = (id) => id === "c1";
  for (const id of ids) store.timeline(id);
  const kept = store.cachedTimelineCount();
  expect(kept <= 4, `상한 3 + 살아 있는 1 ${kept}`);
  expect(store.timeline("c1")[0].id === "c1-m", "살아 있는 세션은 남아 있다");
  const again = store.timeline("c2");
  expect(again.length === 1 && (again[0] as { text: string }).text === "c2", "내린 타임라인은 파일에서 다시 읽는다");
  store.upsertItem("c3", { id: "c3-new", kind: "notice", text: "pending" } as TimelineItem);
  for (const id of ["c4", "c5", "c6", "c7", "c2"]) store.timeline(id);
  expect(store.timeline("c3").some((i) => i.id === "c3-new"), "저장이 밀린 타임라인은 내리지 않아 새 항목이 남는다");
  await sleep(700);
  expect((JSON.parse(readFileSync(join(home, "timelines", "c3.json"), "utf8")) as TimelineItem[]).some((i) => i.id === "c3-new"), "그 변경은 파일에도 저장된다");
  store.flush();
});

test("Store.timeline: 읽을 수 없는 타임라인 파일은 던지지도 덮어쓰지도 않고 옆에 남긴다", () => {
  const store = new Store();
  const torn = '[{"id":"u1","kind":"user","text":"kept conver';
  writeFileSync(join(home, "timelines", "torn.json"), torn);
  expect(store.timeline("torn").length === 0, "읽을 수 없으면 빈 타임라인으로 연다");
  store.upsertItem("torn", { id: "n1", kind: "notice", text: "after" } as TimelineItem);
  store.flush();
  const aside = readdirSync(join(home, "timelines")).filter((name) => name.startsWith("torn.json.corrupt-"));
  expect(aside.length === 1 && readFileSync(join(home, "timelines", aside[0]), "utf8") === torn, `원래 내용은 옆 파일에 그대로 ${aside.join()}`);
  expect(readFileSync(join(home, "timelines", "torn.json"), "utf8") === '[{"id":"n1","kind":"notice","text":"after"}]', "새 항목은 새 파일에");
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
