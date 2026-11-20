import type { Agent, ServerEvent, TimelineItem, Workspace } from "../../shared/protocol";
import type { TimelinePage } from "../../shared/mobile";
import type { ConnStatus } from "../src/net/rpc";
import { AppStore, type Cache, type Link } from "../src/state/store";
import { expect, run, sleep, test } from "./harness";

class MemoryCache implements Cache {
  data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async remove(keys: string[]) {
    for (const key of keys) this.data.delete(key);
  }
}

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, workspaceId: "w1", title: `session ${id}`, status: "idle", updatedAt: "2026-10-20T00:00:00Z", createdAt: "2026-10-20T00:00:00Z", ...extra }) as Agent;
const a = (id: string, text = id): TimelineItem => ({ id, kind: "assistant", text, streaming: false });
const W: Workspace[] = [{ id: "w1", name: "alpha", dir: "/alpha", parentId: null }];

class FakeLink implements Link {
  status: ConnStatus = "online";
  host: string | null = "127.0.0.1";
  calls: { method: string; params: Record<string, unknown> }[] = [];
  agents: Agent[] = [agent("s1"), agent("s2", { unread: true })];
  timelines: Record<string, TimelineItem[]> = { s1: Array.from({ length: 100 }, (_, i) => a(`m${i}`)), s2: [a("x1")] };
  private events = new Set<(e: ServerEvent) => void>();
  private statuses = new Set<(s: ConnStatus) => void>();
  private readies = new Set<(r: { host: string }) => void>();
  delay = 0;
  async call(method: string, params: unknown): Promise<unknown> {
    const p = params as Record<string, unknown>;
    this.calls.push({ method, params: p });
    if (this.delay) await sleep(this.delay);
    switch (method) {
      case "agents.list":
        return this.agents;
      case "workspaces.list":
        return W;
      case "agents.timelinePage": {
        const all = this.timelines[p.agentId as string] ?? [];
        const at = p.beforeId ? all.findIndex((i) => i.id === p.beforeId) : all.length;
        const start = Math.max(0, at - (p.limit as number));
        return { items: all.slice(start, at), hasMore: start > 0, total: all.length } satisfies TimelinePage;
      }
      default:
        return null;
    }
  }
  onEvent(listener: (e: ServerEvent) => void) {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  onStatus(listener: (s: ConnStatus) => void) {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }
  onReady(listener: (r: { host: string }) => void) {
    this.readies.add(listener);
    return () => this.readies.delete(listener);
  }
  emit(event: ServerEvent) {
    for (const l of this.events) l(event);
  }
  ready() {
    for (const l of this.readies) l({ host: "TestMac" });
  }
  setStatus(s: ConnStatus) {
    this.status = s;
    for (const l of this.statuses) l(s);
  }
}

const settle = () => sleep(20);

test("연결되면 목록과 폴더를 받아 채우고 캐시에 저장한다", async () => {
  const cache = new MemoryCache();
  const store = new AppStore(cache);
  const link = new FakeLink();
  store.attach(link);
  link.ready();
  await settle();
  const state = store.getState();
  expect(state.loaded && state.agents.length === 2 && state.workspaces.length === 1 && state.hostName === "TestMac" && state.syncedAt !== null, JSON.stringify(state.agents.map((x) => x.id)));
  await store.flushSave();
  expect(cache.data.has("cache:v1:index"), "index cached");
  return "ok";
});

test("다음 실행: 캐시만으로 서버 응답 전에 목록과 마지막 메시지가 보인다", async () => {
  const cache = new MemoryCache();
  const first = new AppStore(cache);
  const link = new FakeLink();
  first.attach(link);
  link.ready();
  await settle();
  await first.openSession("s1");
  await first.flushSave();

  const second = new AppStore(cache);
  const started = performance.now();
  expect(await second.loadCache(), "cache read");
  const state = second.getState();
  expect(state.loaded && state.agents.length === 2, "list is there before any connection");
  const offline = new FakeLink();
  offline.status = "offline";
  second.attach(offline);
  await second.openSession("s1");
  const tl = second.getState().timelines.s1;
  expect(tl.items.length === 40 && tl.items.at(-1)!.id === "m99" && tl.hasMore && !tl.synced, `cached tail ${tl.items.length} synced=${tl.synced}`);
  const ms = performance.now() - started;
  expect(ms < 50, `cache path ${ms.toFixed(1)}ms`);
  return `${ms.toFixed(1)}ms`;
});

test("세션 열기: 끝 60개를 받고 위로 스크롤하면 이전 조각을 이어 붙인다", async () => {
  const store = new AppStore(new MemoryCache());
  const link = new FakeLink();
  store.attach(link);
  link.ready();
  await settle();
  await store.openSession("s1");
  let tl = store.getState().timelines.s1;
  expect(tl.items.length === 60 && tl.items[0].id === "m40" && tl.hasMore && tl.synced, `${tl.items.length} ${tl.items[0].id}`);
  expect(link.calls.some((c) => c.method === "agents.setOpen" && JSON.stringify(c.params.agentIds) === '["s1"]'), "server told this session is open");
  await store.loadOlder("s1");
  tl = store.getState().timelines.s1;
  expect(tl.items.length === 100 && tl.items[0].id === "m0" && !tl.hasMore && !tl.loadingOlder, `${tl.items.length}`);
  const before = link.calls.length;
  await store.loadOlder("s1");
  expect(link.calls.length === before, "no more pages to load");
  return "ok";
});

test("안 읽은 세션을 열면 읽음으로 표시한다", async () => {
  const store = new AppStore(new MemoryCache());
  const link = new FakeLink();
  store.attach(link);
  link.ready();
  await settle();
  await store.openSession("s2");
  expect(link.calls.some((c) => c.method === "agents.markRead" && c.params.agentId === "s2" && c.params.read === true), "markRead sent");
  return "ok";
});

test("보고 있는 세션이 안 읽음이 되면 읽음으로 돌린다, 열지 않은 세션은 그대로 둔다", async () => {
  const store = new AppStore(new MemoryCache());
  const link = new FakeLink();
  store.attach(link);
  link.ready();
  await settle();
  await store.openSession("s1");
  link.calls.length = 0;
  link.emit({ type: "agent", agent: agent("s1", { unread: true }) });
  link.emit({ type: "agent", agent: agent("s2", { unread: true }) });
  expect(link.calls.filter((c) => c.method === "agents.markRead").map((c) => c.params.agentId).join() === "s1", "only the open session");
  return "ok";
});

test("이벤트: 항목 갱신은 스트리밍 글을 바꾸고, 열지 않은 세션의 항목은 무시한다", async () => {
  const store = new AppStore(new MemoryCache());
  const link = new FakeLink();
  store.attach(link);
  link.ready();
  await settle();
  await store.openSession("s2");
  link.emit({ type: "timelineUpsert", agentId: "s2", item: { id: "n1", kind: "assistant", text: "hel", streaming: true } });
  link.emit({ type: "timelineUpsert", agentId: "s2", item: { id: "n1", kind: "assistant", text: "hello", streaming: true } });
  link.emit({ type: "timelineUpsert", agentId: "never-opened", item: a("zz") });
  const items = store.getState().timelines.s2.items;
  expect(items.length === 2 && (items[1] as { text: string }).text === "hello", JSON.stringify(items));
  expect(!("never-opened" in store.getState().timelines), "unopened session ignored");
  link.emit({ type: "timelineRemove", agentId: "s2", itemId: "n1" });
  expect(store.getState().timelines.s2.items.length === 1, "removed");
  link.emit({ type: "agent", agent: agent("s3") });
  link.emit({ type: "agent", agent: agent("s1", { status: "running" }) });
  expect(store.getState().agents.length === 3 && store.getState().agents.find((x) => x.id === "s1")!.status === "running", "agent upsert");
  link.emit({ type: "agentRemoved", agentId: "s2" });
  expect(!store.getState().agents.some((x) => x.id === "s2") && !("s2" in store.getState().timelines), "agent removed with its timeline");
  return "ok";
});

test("재연결: 끊긴 사이 생긴 항목을 끝 조각으로 다시 받아 맞춘다", async () => {
  const store = new AppStore(new MemoryCache());
  const link = new FakeLink();
  store.attach(link);
  link.ready();
  await settle();
  await store.openSession("s2");
  link.setStatus("offline");
  expect(store.getState().conn === "offline", "status mirrors the link");
  // 끊긴 사이 서버에서 일어난 일: 새 항목 둘, 기존 항목 갱신, 상태 변경
  link.timelines.s2 = [a("x1", "edited while away"), a("x2"), a("x3")];
  link.agents = [agent("s1"), agent("s2", { status: "running" })];
  link.setStatus("online");
  link.ready();
  await settle();
  const items = store.getState().timelines.s2.items;
  expect(items.map((i) => i.id).join() === "x1,x2,x3" && (items[0] as { text: string }).text === "edited while away", JSON.stringify(items.map((i) => i.id)));
  expect(store.getState().agents.find((x) => x.id === "s2")!.status === "running", "agent state resynced");
  return "ok";
});

test("동기화가 겹쳐도 한 번만 부른다", async () => {
  const store = new AppStore(new MemoryCache());
  const link = new FakeLink();
  link.delay = 30;
  store.attach(link);
  link.ready();
  link.ready();
  link.ready();
  await sleep(150);
  expect(link.calls.filter((c) => c.method === "agents.list").length === 1, `agents.list called ${link.calls.filter((c) => c.method === "agents.list").length} times`);
  return "ok";
});

test("reset: 상태와 캐시를 비운다", async () => {
  const cache = new MemoryCache();
  const store = new AppStore(cache);
  const link = new FakeLink();
  store.attach(link);
  link.ready();
  await settle();
  await store.openSession("s1");
  await store.flushSave();
  expect(cache.data.size >= 2, "something cached");
  await store.reset();
  expect(cache.data.size === 0 && store.getState().agents.length === 0 && !store.getState().loaded, "cleared");
  return "ok";
});

test("동작은 연결이 없으면 오류로 돌려준다", async () => {
  const store = new AppStore(new MemoryCache());
  let message = "";
  await store.send("s1", "hi").catch((e: Error) => (message = e.message));
  expect(/Not connected/.test(message), message);
  return message;
});

// 워크스페이스 동작은 데몬이 돌려주는 값을 흉내 내는 연결로 시험한다(실제 데몬과의 왕복은 루트 시험이 본다)
class WorkspaceLink extends FakeLink {
  timeouts: (number | undefined)[] = [];
  override async call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const p = params as Record<string, unknown>;
    switch (method) {
      case "workspaces.add":
        this.calls.push({ method, params: p });
        return { id: "w2", name: "newer", dir: String(p.dir), parentId: null };
      case "workspaces.remove":
        this.calls.push({ method, params: p });
        return { hidden: 1 };
      case "git.branches":
        this.calls.push({ method, params: p });
        return { repoRoot: "/alpha", current: "main", defaultBase: "main", branches: ["main"], locals: ["main"], remotes: [], uncommitted: 3 };
      case "agents.create":
        this.timeouts.push(timeoutMs);
        this.calls.push({ method, params: p });
        return agent("new1");
      default:
        return super.call(method, params);
    }
  }
}

test("워크스페이스 추가: 데몬의 이벤트를 기다리지 않고 목록에 바로 넣고, 같은 응답이 다시 와도 하나다", async () => {
  const store = new AppStore(new MemoryCache());
  const link = new WorkspaceLink();
  store.attach(link);
  link.ready();
  await settle();
  const added = await store.addWorkspace("/Users/me/newer");
  expect(added.id === "w2" && store.getState().workspaces.map((w) => w.id).join() === "w1,w2", store.getState().workspaces.map((w) => w.id).join());
  link.emit({ type: "workspaces", workspaces: [...W, added] });
  await store.addWorkspace("/Users/me/newer");
  expect(store.getState().workspaces.length === 2, "not duplicated");
  expect(JSON.stringify(link.calls.find((c) => c.method === "workspaces.add")!.params) === '{"dir":"/Users/me/newer"}', "dir sent as typed");
  return "ok";
});

test("워크스페이스 빼기: 그 폴더와 아래 worktree 와 세션을 화면에서 치우고 git 요약도 지운다", async () => {
  const store = new AppStore(new MemoryCache());
  const link = new WorkspaceLink();
  link.agents = [agent("s1"), agent("s2", { workspaceId: "w1-wt" }), agent("s3", { workspaceId: "w9" }), agent("s4", { workspaceId: null })];
  store.attach(link);
  link.ready();
  await settle();
  store.getState().workspaces.push({ id: "w1-wt", name: "alpha (x)", dir: "/alpha.worktrees/x", parentId: "w1" });
  await store.branches("w1");
  expect(store.getState().git.w1?.current === "main" && store.getState().git.w1.uncommitted === 3, "git summary stored");
  const result = await store.removeWorkspace("w1");
  expect(result.hidden === 1, "hidden count passed on");
  const state = store.getState();
  expect(state.workspaces.length === 0 && state.agents.map((x) => x.id).join() === "s3,s4" && !("w1" in state.git), `${state.workspaces.length} ${state.agents.map((x) => x.id).join()}`);
  return "ok";
});

test("새 세션: worktree 를 같이 보내면 기다리는 시간이 길어지고, 안 보내면 기본값", async () => {
  const store = new AppStore(new MemoryCache());
  const link = new WorkspaceLink();
  store.attach(link);
  await store.createSession("w1", "hello");
  await store.createSession("w1", "hello", undefined, { branch: "feature/x", base: "main" });
  const creates = link.calls.filter((c) => c.method === "agents.create");
  expect(!("worktree" in creates[0].params) && JSON.stringify(creates[1].params.worktree) === '{"branch":"feature/x","base":"main"}', JSON.stringify(creates.map((c) => c.params)));
  expect(link.timeouts[0] === undefined && (link.timeouts[1] ?? 0) >= 60_000, `timeouts ${link.timeouts.join()}`);
  return "ok";
});

test("세션 이름, 고정, 보관은 인자 그대로 데몬에 보낸다", async () => {
  const store = new AppStore(new MemoryCache());
  const link = new WorkspaceLink();
  store.attach(link);
  await store.rename("s1", "새 이름");
  await store.setPinned("s1", true);
  await store.setDone("s1", false);
  await store.checkBranchName("w1", "x").catch(() => {});
  const sent = link.calls.map((c) => `${c.method} ${JSON.stringify(c.params)}`);
  expect(sent[0] === 'agents.rename {"agentId":"s1","title":"새 이름"}' && sent[1] === 'agents.setPinned {"agentId":"s1","pinned":true}' && sent[2] === 'agents.setDone {"agentId":"s1","done":false}' && sent[3] === 'git.checkBranchName {"workspaceId":"w1","branch":"x"}', sent.join("\n"));
  return "ok";
});

void run();
