// LINEAR: Linear 연동의 데몬 쪽(server/linear*.ts, shared/linear.ts)을 확인한다. Linear 에는 닿지 않는다: 이 파일이 로컬 http 로 가짜 Linear GraphQL 서버를 띄운다.
// 가짜 서버는 데몬이 보낸 IssueFilter 를 직접 해석해서(모르는 칸이 오면 400) 필터가 의도한 이슈를 고르는지까지 본다. 실행: npm test
// 실제 macOS 키체인 시험은 AGENT_NAV_LINEAR_REAL_KEYCHAIN=1 일 때만 돈다(임시 service 이름으로 만들고 지운다).
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MOBILE_METHODS } from "../shared/mobile";
import { linearIssueDraft, type LinearIssue, type LinearRpcMethods } from "../shared/linear";
import { LinearApi } from "../server/linearApi";
import { keychainStore, keyStoreFor, memoryStore, systemSecurity, validKeyShape, type SecurityRunner } from "../server/linearKey";
import { linearHandlers, ISSUES_TTL_MS, META_TTL_MS } from "../server/linear";
import { buildIssueFilter, normalizeFilter } from "../server/linearFilter";

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

const GOOD = "lin_api_GOODKEY0123456789abcdefghijklmnopqrst";
const OTHER = "lin_api_OTHERKEY123456789abcdefghijklmnopqrs";
const BAD401 = "lin_api_BADKEY401_23456789abcdefghijklmnopq";
const BAD400 = "lin_api_BADKEY400_23456789abcdefghijklmnopq";
const ECHO = "lin_api_ECHOKEY0123456789abcdefghijklmnopqrs";

// --- 가짜 Linear ---
type Raw = Record<string, any>;
const STATES: Raw[] = [
  { id: "s-j-todo", name: "Todo", type: "unstarted", color: "#e2e2e2", position: 1, team: { id: "t-jobl" } },
  { id: "s-j-doing", name: "In Progress", type: "started", color: "#f2c94c", position: 2, team: { id: "t-jobl" } },
  { id: "s-j-done", name: "Done", type: "completed", color: "#5e6ad2", position: 3, team: { id: "t-jobl" } },
  { id: "s-a-back", name: "Backlog", type: "backlog", color: "#bec2c8", position: 0, team: { id: "t-ads" } },
  { id: "s-a-cancel", name: "Canceled", type: "canceled", color: "#95a2b3", position: 4, team: { id: "t-ads" } },
];
const state = (id: string) => STATES.find((s) => s.id === id)!;
const LABELS: Raw[] = [
  { id: "l-bug", name: "Bug", color: "#eb5757", team: null },
  { id: "l-fe", name: "FE", color: "#4cb782", team: { id: "t-jobl" } },
  { id: "l-ads", name: "Ads", color: "#f2994a", team: { id: "t-ads" } },
];
const ME = { id: "u-me", name: "Alex", email: "alex@example.com", avatarUrl: "https://example.com/me.png" };
const OTHER_USER = { id: "u-other", name: "Mina", avatarUrl: null };
const mkIssue = (n: number, team: "jobl" | "ads", stateId: string, patch: Raw): Raw => ({
  id: `id-${n}`,
  identifier: `${team === "jobl" ? "JOBL" : "ADS"}-${n}`,
  number: n,
  title: `Issue ${n}`,
  description: `Description ${n}`,
  url: `https://linear.example/issue/${team}-${n}`,
  priority: 3,
  priorityLabel: "Medium",
  updatedAt: `2026-10-${String(30 - n).padStart(2, "0")}T00:00:00.000Z`,
  stateId,
  labels: [],
  assignee: null,
  team: team === "jobl" ? { id: "t-jobl", key: "JOBL", name: "Jobs" } : { id: "t-ads", key: "ADS", name: "Ads" },
  cycle: null,
  ...patch,
});
const freshIssues = (): Raw[] => [
  mkIssue(1, "jobl", "s-j-doing", { assignee: ME, priority: 1, priorityLabel: "Urgent", labels: [LABELS[1]], cycle: { id: "c-12", number: 12, name: null }, title: "Fix login crash" }),
  mkIssue(2, "jobl", "s-j-todo", { assignee: ME, priority: 2, priorityLabel: "High", labels: [LABELS[0]] }),
  mkIssue(3, "jobl", "s-j-done", { assignee: ME }),
  mkIssue(4, "jobl", "s-j-todo", { assignee: OTHER_USER, description: "x".repeat(900) }),
  mkIssue(5, "ads", "s-a-back", { assignee: ME, labels: [LABELS[2]], priority: 0, priorityLabel: "No priority" }),
  mkIssue(6, "ads", "s-a-cancel", { assignee: null }),
  mkIssue(7, "ads", "s-a-back", { assignee: null, title: "Banner login copy" }),
];

type Mode = "ok" | "rateLimitedError" | "exhaustedHeaders" | "serverError" | "forbidden";
const fake = {
  mode: "ok" as Mode,
  requests: [] as { auth: string | undefined; op: string; variables: Raw; text: string }[],
  issues: freshIssues(),
  resetAt: 0,
};

const containsIgnoreCase = (value: unknown, needle: string) => typeof value === "string" && value.toLowerCase().includes(needle.toLowerCase());
function matches(issue: Raw, filter: Raw): boolean {
  for (const [field, cond] of Object.entries(filter) as [string, any][]) {
    const st = state(issue.stateId);
    if (field === "or") {
      if (!cond.some((c: Raw) => matches(issue, c))) return false;
    } else if (field === "team") {
      if (cond.id && !cond.id.in.includes(issue.team.id)) return false;
      if (cond.key && issue.team.key.toLowerCase() !== cond.key.eqIgnoreCase.toLowerCase()) return false;
      if (Object.keys(cond).some((k) => k !== "id" && k !== "key")) throw new Error(`unknown team filter ${JSON.stringify(cond)}`);
    } else if (field === "number") {
      if (issue.number !== cond.eq) return false;
    } else if (field === "assignee") {
      if (cond.isMe) {
        if (issue.assignee?.id !== ME.id) return false;
      } else if (cond.null === true) {
        if (issue.assignee !== null) return false;
      } else if (cond.id) {
        if (issue.assignee?.id !== cond.id.eq) return false;
      } else throw new Error(`unknown assignee filter ${JSON.stringify(cond)}`);
    } else if (field === "state") {
      if (cond.type.in && !cond.type.in.includes(st.type)) return false;
      if (cond.type.nin && cond.type.nin.includes(st.type)) return false;
    } else if (field === "cycle") {
      if (issue.cycle?.id !== cond.id.eq) return false;
    } else if (field === "labels") {
      if (!issue.labels.some((l: Raw) => cond.id.in.includes(l.id))) return false;
    } else if (field === "priority") {
      if (!cond.in.includes(issue.priority)) return false;
    } else if (field === "title" || field === "description") {
      if (!containsIgnoreCase(issue[field], cond.containsIgnoreCase)) return false;
    } else throw new Error(`unknown filter field ${field}`);
  }
  return true;
}

const wireIssue = (issue: Raw): Raw => {
  const { stateId, number: _n, ...rest } = issue;
  const st = state(stateId);
  return { ...rest, state: { id: st.id, name: st.name, type: st.type, color: st.color }, labels: { nodes: issue.labels.map((l: Raw) => ({ name: l.name, color: l.color })) }, cycle: issue.cycle ? { number: issue.cycle.number, name: issue.cycle.name } : null };
};

// 메타 질의는 first 를 문서에 박아 두므로 변수에 없으면 크게 잡는다.
const page = (items: Raw[], first: number | undefined, after: string | null | undefined) => {
  first ??= 1000;
  const start = after ? Number(after.slice(1)) : 0;
  const nodes = items.slice(start, start + first);
  const end = start + nodes.length;
  return { nodes, pageInfo: { hasNextPage: end < items.length, endCursor: end < items.length ? `c${end}` : null } };
};

function answer(body: Raw): { status: number; headers?: Record<string, string>; json: Raw } {
  const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "";
  const v = body.variables ?? {};
  if (op === "LodestarViewer") return { status: 200, json: { data: { viewer: ME, organization: { name: "Example", urlKey: "example" } } } };
  if (op === "LodestarTeams") return { status: 200, json: { data: { teams: page([{ id: "t-jobl", key: "JOBL", name: "Jobs", cyclesEnabled: true }, { id: "t-ads", key: "ADS", name: "Ads", cyclesEnabled: false }], v.first, v.after) } } };
  if (op === "LodestarStates") return { status: 200, json: { data: { workflowStates: page(STATES, v.first, v.after) } } };
  // 라벨은 한 쪽에 둘씩만 줘서 데몬이 커서로 끝까지 읽는지 본다.
  if (op === "LodestarLabels") return { status: 200, json: { data: { issueLabels: page(LABELS, 2, v.after) } } };
  if (op === "LodestarCycles") return { status: 200, json: { data: { cycles: page([{ id: "c-12", number: 12, name: null, startsAt: "2026-10-12", endsAt: "2026-10-26", isActive: true, isNext: false, team: { id: "t-jobl" } }], v.first, v.after) } } };
  if (op === "LodestarIssues") {
    const hits = fake.issues.filter((i) => matches(i, v.filter ?? {})).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const p = page(hits.map(wireIssue), v.first, v.after);
    return { status: 200, json: { data: { issues: p } } };
  }
  if (op === "LodestarIssue") {
    const hit = fake.issues.find((i) => i.id === v.id || i.identifier === v.id);
    return { status: 200, json: { data: { issue: hit ? wireIssue(hit) : null } } };
  }
  if (op === "LodestarIssueUpdate") {
    const input = v.input ?? {};
    const extra = Object.keys(input).filter((k) => k !== "stateId" && k !== "priority");
    if (extra.length) return { status: 400, json: { errors: [{ message: `unexpected input ${extra.join(",")}`, extensions: { type: "invalid input" } }] } };
    const issue = fake.issues.find((i) => i.id === v.id);
    if (!issue) return { status: 200, json: { errors: [{ message: "Entity not found: Issue", extensions: { type: "invalid input" } }] } };
    if (input.stateId !== undefined) issue.stateId = input.stateId;
    if (input.priority !== undefined) {
      issue.priority = input.priority;
      issue.priorityLabel = ["No priority", "Urgent", "High", "Medium", "Low"][input.priority];
    }
    return { status: 200, json: { data: { issueUpdate: { success: true, issue: wireIssue(issue) } } } };
  }
  return { status: 400, json: { errors: [{ message: `unknown operation ${op}`, extensions: { type: "invalid input" } }] } };
}

function handle(req: IncomingMessage, res: ServerResponse, text: string) {
  const auth = req.headers.authorization;
  const body = JSON.parse(text || "{}") as Raw;
  const op = /(?:query|mutation)\s+(\w+)/.exec(body.query ?? "")?.[1] ?? "";
  fake.requests.push({ auth, op, variables: body.variables ?? {}, text });
  const send = (status: number, json: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(json));
  };
  if (auth === BAD400) return send(400, { errors: [{ message: "Authentication required, not authenticated", extensions: { type: "authentication error", code: "AUTHENTICATION_ERROR", userError: true } }] });
  if (auth === ECHO) return send(400, { errors: [{ message: `Variable invalid for ${ECHO}`, extensions: { type: "invalid input" } }] });
  if (auth !== GOOD && auth !== OTHER) return send(401, { errors: [{ message: "Unauthorized", extensions: { type: "authentication error" } }] });
  if (fake.mode === "rateLimitedError") return send(400, { errors: [{ message: "Rate limit exceeded", extensions: { type: "ratelimited", code: "RATELIMITED" } }] }, { "x-ratelimit-requests-reset": String(fake.resetAt) });
  if (fake.mode === "serverError") return send(502, "bad gateway");
  if (fake.mode === "forbidden") return send(200, { errors: [{ message: "forbidden", extensions: { type: "forbidden", code: "FORBIDDEN" } }] });
  const reply = answer(body);
  const headers: Record<string, string> = { "x-ratelimit-requests-limit": "2500", "x-ratelimit-requests-remaining": fake.mode === "exhaustedHeaders" ? "0" : "2400", "x-ratelimit-requests-reset": String(fake.resetAt) };
  send(reply.status, reply.json, headers);
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => handle(req, res, Buffer.concat(chunks).toString("utf8")));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// --- 시험 도구 ---
let clock = 1_800_000_000_000;
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ AGENT_NAV_LINEAR_API: BASE, ...extra });
const logs: string[] = [];
const saved = { log: console.log, error: console.error, warn: console.warn };
const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));

function make(initialKey: string | null = GOOD, e: NodeJS.ProcessEnv = env()) {
  fake.mode = "ok";
  fake.requests = [];
  fake.issues = freshIssues();
  fake.resetAt = clock + 3_600_000;
  const keys = memoryStore(initialKey);
  const api = new LinearApi({ env: e, keys, now: () => clock });
  const refs: { agentId: string; issue: unknown }[] = [];
  const h = linearHandlers({ api, keys, now: () => clock, setAgentIssue: (agentId, issue) => refs.push({ agentId, issue }), log: capture });
  const call = <M extends keyof LinearRpcMethods>(method: M, params: LinearRpcMethods[M]["params"]) => (h[method] as (p: unknown) => Promise<LinearRpcMethods[M]["result"]>)(params);
  return { h, call, keys, refs };
}

async function issuesOf(call: ReturnType<typeof make>["call"], filter?: Raw, extra: Raw = {}) {
  const result = await call("linear.issues", { filter: filter as never, ...extra });
  if (!result.ok) throw new Error(`issues failed: ${result.error.kind} ${result.error.message}`);
  return result.data;
}
const ids = (issues: LinearIssue[]) => issues.map((i) => i.identifier);

// --- 필터 ---
test("filter: 내 이슈는 담당자 isMe 와 열린 상태(completed, canceled 제외)로 바뀐다", () => {
  const built = buildIssueFilter(normalizeFilter({ assignee: "me" }));
  expect(JSON.stringify(built) === JSON.stringify({ assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled"] } } }), JSON.stringify(built));
});

test("filter: 검증은 모르는 값을 거절하고 정리한다 (중복, 순서, 빈 칸)", () => {
  const n = normalizeFilter({ teamIds: ["b", "a", "a"], priorities: [2, 1], stateTypes: [], query: "  hi  ", assignee: null });
  expect(JSON.stringify(n) === JSON.stringify({ teamIds: ["a", "b"], assignee: "unassigned", priorities: [1, 2], query: "hi" }), JSON.stringify(n));
  for (const bad of [{ priorities: [9] }, { stateTypes: ["nope"] }, { teamIds: "x" }, { includeCompleted: "yes" }, [], "x"]) {
    let message = "";
    try {
      normalizeFilter(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message !== "", `거절돼야 함: ${JSON.stringify(bad)}`);
  }
});

test("filter: 식별자 모양 검색어는 팀 key 와 번호 조건도 추가한다", () => {
  const or = (buildIssueFilter(normalizeFilter({ query: "jobl-12" })) as { or: unknown[] }).or;
  expect(or.length === 3 && JSON.stringify(or[2]) === JSON.stringify({ team: { key: { eqIgnoreCase: "jobl" } }, number: { eq: 12 } }), JSON.stringify(or));
});

// --- 키 저장소 ---
test("key: 환경 변수 키는 가짜 서버(AGENT_NAV_LINEAR_API)일 때만 듣고, 운영은 키체인이다", async () => {
  const calls: string[][] = [];
  const run: SecurityRunner = async (args) => (calls.push(args), { code: 44, stdout: "", stderr: "" });
  const real = keyStoreFor({ AGENT_NAV_LINEAR_KEY: GOOD }, run);
  expect((await real.read()) === null && calls.length === 1 && calls[0][0] === "find-generic-password", "API 환경 변수가 없으면 키체인을 읽는다");
  expect(calls[0].join(" ") === "find-generic-password -s lodestar-linear -a api-key -w", calls[0].join(" "));
  const faked = keyStoreFor({ AGENT_NAV_LINEAR_API: BASE, AGENT_NAV_LINEAR_KEY: GOOD }, run);
  expect((await faked.read()) === GOOD && calls.length === 1, "가짜 서버면 환경 변수 키");
  const overridden = keyStoreFor({ AGENT_NAV_LINEAR_API: BASE, AGENT_NAV_LINEAR_KEYCHAIN_SERVICE: "lodestar-linear-test" }, run);
  await overridden.read();
  expect(calls[1].includes("lodestar-linear-test"), "service 이름 덮어쓰기는 가짜 서버일 때만");
  const ignored = keyStoreFor({ AGENT_NAV_LINEAR_KEYCHAIN_SERVICE: "lodestar-linear-test" }, run);
  await ignored.read();
  expect(calls[2].includes("lodestar-linear") && !calls[2].includes("lodestar-linear-test"), "운영에서는 service 이름을 못 바꾼다");
});

test("key: 저장은 security -i 의 stdin 으로만 가고 인자에는 키가 없다", async () => {
  const calls: { args: string[]; stdin?: string }[] = [];
  let stored: string | null = null;
  const run: SecurityRunner = async (args, stdin) => {
    calls.push({ args, stdin });
    if (args[0] === "-i") stored = /-w "([^"]*)"/.exec(stdin ?? "")?.[1] ?? null;
    if (args[0] === "find-generic-password") return stored ? { code: 0, stdout: `${stored}\n`, stderr: "" } : { code: 44, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = keychainStore(run);
  await store.write(GOOD);
  const write = calls.find((c) => c.args[0] === "-i")!;
  expect(write.args.length === 1 && !calls.some((c) => c.args.join(" ").includes(GOOD)), "키가 인자에 있음");
  expect(write.stdin === `add-generic-password -U -s "lodestar-linear" -a "api-key" -w "${GOOD}"\n`, JSON.stringify(write.stdin));
  expect((await store.read()) === GOOD, "읽기");
  let rejected = 0;
  for (const bad of ['a"b', "has space", "short", "line\nbreak", `${GOOD}"; delete-generic-password`]) {
    try {
      await store.write(bad);
    } catch {
      rejected++;
    }
  }
  expect(rejected === 5 && calls.filter((c) => c.args[0] === "-i").length === 1, "이상한 키는 security 를 부르기 전에 거절");
  expect(!validKeyShape("lin_api_short") && validKeyShape(GOOD), "키 모양");
});

test("key: 다시 읽어 맞지 않으면 실패, 읽기 오류는 항목 없음(44)과 구분", async () => {
  const lost = keychainStore(async (args) => (args[0] === "find-generic-password" ? { code: 44, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" }));
  let message = "";
  await lost.write(GOOD).catch((e: Error) => (message = e.message));
  expect(message.includes("Could not save") && !message.includes(GOOD), message);
  const broken = keychainStore(async () => ({ code: 36, stdout: "", stderr: "User interaction is not allowed." }));
  await broken.read().catch((e: Error) => (message = e.message));
  expect(message.includes("security exited 36"), message);
  expect(await keychainStore(async () => ({ code: 44, stdout: "", stderr: "" })).clear().then(() => true), "삭제할 게 없어도 괜찮다");
});

if (process.env.AGENT_NAV_LINEAR_REAL_KEYCHAIN === "1") {
  test("key: 실제 키체인에 임시 service 로 저장, 읽기, 덮어쓰기, 삭제", async () => {
    const store = keychainStore(systemSecurity(), `lodestar-linear-test-${process.pid}`);
    try {
      expect((await store.read()) === null, "처음엔 없음");
      await store.write(GOOD);
      expect((await store.read()) === GOOD, "저장");
      await store.write(OTHER);
      expect((await store.read()) === OTHER, "덮어쓰기(-U)");
    } finally {
      await store.clear();
    }
    expect((await store.read()) === null, "삭제");
  });
}

// --- 상태와 키 ---
test("status: 키 없음은 오류가 아니라 noKey 상태로 돌려준다 (요청도 안 보낸다)", async () => {
  const { call } = make(null);
  const status = await call("linear.status", {});
  expect(!status.connected && status.error.kind === "noKey" && fake.requests.length === 0, JSON.stringify(status));
});

test("status: 연결됨이면 viewer 이름과 이메일, 인증 헤더는 키 그대로(Bearer 없음)", async () => {
  const { call } = make();
  const status = await call("linear.status", {});
  expect(status.connected && status.viewer.name === "Alex" && status.viewer.email === "alex@example.com" && status.organization?.urlKey === "example", JSON.stringify(status));
  expect(fake.requests[0].auth === GOOD, `Authorization: ${fake.requests[0].auth}`);
  await call("linear.status", {});
  expect(fake.requests.length === 1, "1분 캐시");
  await call("linear.status", { force: true });
  expect(fake.requests.length === 2, "force 는 다시 읽는다");
});

test("status: 401 은 invalidKey (오류가 아니라 상태)", async () => {
  const { call } = make(BAD401);
  const status = await call("linear.status", {});
  expect(!status.connected && status.error.kind === "invalidKey", JSON.stringify(status));
});

test("setKey: 확인 없이는 거절, 키 모양이 틀리면 Linear 에 묻지도 않는다", async () => {
  const { call, keys } = make(null);
  let message = "";
  await call("linear.setKey", { key: GOOD } as never).catch((e: Error) => (message = e.message));
  expect(message.includes("confirmation"), message);
  const bad = await call("linear.setKey", { key: "not a key", confirmed: true });
  expect(!bad.connected && bad.error.kind === "invalidKey" && fake.requests.length === 0 && (await keys.read()) === null, JSON.stringify(bad));
});

test("setKey: Linear 가 거절한 키(401, 400 authentication error)는 저장하지 않고, 통과한 키만 저장한다", async () => {
  const { call, keys } = make(null);
  for (const key of [BAD401, BAD400]) {
    const result = await call("linear.setKey", { key, confirmed: true });
    expect(!result.connected && result.error.kind === "invalidKey" && (await keys.read()) === null, `${key.slice(0, 16)}: ${JSON.stringify(result)}`);
  }
  const ok = await call("linear.setKey", { key: ` ${GOOD} `, confirmed: true });
  expect(ok.connected && (await keys.read()) === GOOD, JSON.stringify(ok));
});

test("clearKey: 키를 지우고 캐시도 비운다", async () => {
  const { call, keys } = make();
  await call("linear.meta", {});
  const status = await call("linear.clearKey", { confirmed: true });
  expect(!status.connected && status.error.kind === "noKey" && (await keys.read()) === null, JSON.stringify(status));
  const meta = await call("linear.meta", {});
  expect(!meta.ok && meta.error.kind === "noKey", "지운 뒤에는 캐시된 메타도 안 준다");
});

// --- 메타 ---
test("meta: 팀별 상태(position 순), 라벨(커서로 끝까지), 현재 사이클", async () => {
  const { call } = make();
  const result = await call("linear.meta", {});
  if (!result.ok) throw new Error(JSON.stringify(result));
  const meta = result.data;
  const jobl = meta.teams.find((t) => t.key === "JOBL")!;
  expect(jobl.cyclesEnabled && jobl.states.map((s) => s.name).join() === "Todo,In Progress,Done" && jobl.states[1].type === "started" && jobl.states[1].color === "#f2c94c", JSON.stringify(jobl));
  expect(meta.teams.find((t) => t.key === "ADS")!.states.map((s) => s.name).join() === "Backlog,Canceled", "ADS 상태");
  expect(meta.labels.length === 3 && meta.labels[0].name === "Bug" && meta.labels[0].teamId === null && meta.labels[1].teamId === "t-jobl", JSON.stringify(meta.labels));
  expect(meta.cycles.length === 1 && meta.cycles[0].isActive && meta.cycles[0].teamId === "t-jobl", JSON.stringify(meta.cycles));
  const labelCalls = fake.requests.filter((r) => r.op === "LodestarLabels");
  expect(labelCalls.length === 2 && labelCalls[1].variables.after === "c2", `라벨 요청 ${labelCalls.length}번`);
});

test("meta: 10분 캐시, force 는 다시, TTL 이 지나면 다시", async () => {
  const { call } = make();
  await call("linear.meta", {});
  const first = fake.requests.length;
  await call("linear.meta", {});
  expect(fake.requests.length === first, "캐시");
  clock += META_TTL_MS - 1000;
  await call("linear.meta", {});
  expect(fake.requests.length === first, "9분 59초");
  await call("linear.meta", { force: true });
  expect(fake.requests.length === first * 2, "force");
  clock += META_TTL_MS + 1;
  const before = fake.requests.length;
  await call("linear.meta", {});
  expect(fake.requests.length === before + first, "TTL 후");
});

// --- 이슈 ---
test("issues: 내 이슈 빠른 필터는 내 열린 이슈만 (완료와 취소, 남의 것 제외), 응답은 보드 카드 모양", async () => {
  const { call } = make();
  const data = await issuesOf(call, { assignee: "me" });
  expect(ids(data.issues).join() === "JOBL-1,JOBL-2,ADS-5", ids(data.issues).join());
  const card = data.issues[0];
  expect(
    card.id === "id-1" && card.identifier === "JOBL-1" && card.title === "Fix login crash" && card.url.endsWith("/jobl-1") && card.priority === 1 && card.priorityLabel === "Urgent" &&
      card.state.name === "In Progress" && card.state.type === "started" && card.state.color === "#f2c94c" && card.labels[0].name === "FE" && card.assignee?.name === "Alex" &&
      card.team.key === "JOBL" && card.team.name === "Jobs" && card.cycle?.number === 12 && card.updatedAt.startsWith("2026-10-29"),
    JSON.stringify(card),
  );
  expect(data.hasNextPage === false && data.endCursor === null && fake.requests[0].auth === GOOD, "페이지 정보");
});

test("issues: 팀과 상태 종류, 우선순위, 라벨, 사이클, 담당자 없음 필터", async () => {
  const { call } = make();
  expect(ids((await issuesOf(call, { teamIds: ["t-ads"] })).issues).join() === "ADS-5,ADS-7", "ADS 열린 이슈");
  expect(ids((await issuesOf(call, { teamIds: ["t-jobl"], stateTypes: ["unstarted"] })).issues).join() === "JOBL-2,JOBL-4", "JOBL 의 unstarted");
  expect(ids((await issuesOf(call, { stateTypes: ["completed", "canceled"] })).issues).join() === "JOBL-3,ADS-6", "닫힌 상태를 직접 고름");
  expect(ids((await issuesOf(call, { includeCompleted: true })).issues).length === 7, "includeCompleted 는 전부");
  expect(ids((await issuesOf(call, { priorities: [1, 2] })).issues).join() === "JOBL-1,JOBL-2", "우선순위");
  expect(ids((await issuesOf(call, { labelIds: ["l-bug", "l-ads"] })).issues).join() === "JOBL-2,ADS-5", "라벨 하나라도");
  expect(ids((await issuesOf(call, { cycleId: "c-12" })).issues).join() === "JOBL-1", "사이클");
  expect(ids((await issuesOf(call, { assignee: "unassigned" })).issues).join() === "ADS-7", "담당자 없음(열린 것만)");
  expect(ids((await issuesOf(call, { assignee: null as never })).issues).join() === "ADS-7", "null 도 담당자 없음");
  expect(ids((await issuesOf(call, { assignee: "u-other" })).issues).join() === "JOBL-4", "사용자 id");
});

test("issues: 검색은 제목과 설명(대소문자 무시), 식별자 모양이면 번호로도 찾는다", async () => {
  const { call } = make();
  expect(ids((await issuesOf(call, { query: "LOGIN" })).issues).join() === "JOBL-1,ADS-7", "제목 검색");
  expect(ids((await issuesOf(call, { query: "description 2" })).issues).join() === "JOBL-2", "설명 검색");
  expect(ids((await issuesOf(call, { query: "ads-7" })).issues).join() === "ADS-7", "식별자 검색");
  expect(ids((await issuesOf(call, { query: "login", teamIds: ["t-ads"] })).issues).join() === "ADS-7", "검색과 팀 필터는 AND");
});

test("issues: 페이지네이션은 first 와 after 커서로 이어지고, 쪽마다 캐시된다", async () => {
  const { call } = make();
  const first = await issuesOf(call, undefined, { first: 2 });
  expect(ids(first.issues).join() === "JOBL-1,JOBL-2" && first.hasNextPage && first.endCursor === "c2", JSON.stringify([ids(first.issues), first.endCursor]));
  const second = await issuesOf(call, undefined, { first: 2, after: first.endCursor });
  expect(ids(second.issues).join() === "JOBL-4,ADS-5" && second.hasNextPage, ids(second.issues).join());
  const third = await issuesOf(call, undefined, { first: 2, after: second.endCursor });
  expect(ids(third.issues).join() === "ADS-7" && !third.hasNextPage && third.endCursor === null, ids(third.issues).join());
  const before = fake.requests.length;
  await issuesOf(call, undefined, { first: 2, after: first.endCursor });
  expect(fake.requests.length === before, "같은 쪽은 캐시");
  expect(fake.requests[0].variables.first === 2, "first 전달");
  const big = await issuesOf(call, undefined, { first: 5000 });
  expect(fake.requests[fake.requests.length - 1].variables.first === 100 && big.issues.length === 5, "first 상한 100");
});

test("issues: 설명은 앞부분만 (잘렸으면 표시), linear.issue 는 전체", async () => {
  const { call } = make();
  const list = await issuesOf(call, { assignee: "u-other" });
  expect(list.issues[0].description?.length === 600 && list.issues[0].descriptionTruncated, "목록은 600자");
  const detail = await call("linear.issue", { id: "id-4" });
  expect(detail.ok && detail.data.description?.length === 900 && !detail.data.descriptionTruncated, JSON.stringify(detail.ok ? detail.data.description?.length : detail));
  const missing = await call("linear.issue", { id: "nope" });
  expect(!missing.ok && missing.error.kind === "server", JSON.stringify(missing));
});

test("issues: 30초 캐시, 다른 필터는 따로, force 는 다시, TTL 이 지나면 다시", async () => {
  const { call } = make();
  await issuesOf(call, { assignee: "me" });
  await issuesOf(call, { assignee: "me" });
  await issuesOf(call, { teamIds: ["b", "a"], priorities: [2, 1] });
  await issuesOf(call, { priorities: [1, 2], teamIds: ["a", "b"] });
  expect(fake.requests.length === 2, `요청 ${fake.requests.length}번: 같은 필터(키 순서만 다름)는 한 번`);
  await issuesOf(call, { assignee: "me" }, { force: true });
  expect(fake.requests.length === 3, "force");
  clock += ISSUES_TTL_MS + 1;
  await issuesOf(call, { assignee: "me" });
  expect(fake.requests.length === 4, "30초 후");
});

test("issues: 같은 요청이 동시에 오면 Linear 에는 한 번", async () => {
  const { call } = make();
  await Promise.all([issuesOf(call, { assignee: "me" }), issuesOf(call, { assignee: "me" }), issuesOf(call, { assignee: "me" })]);
  expect(fake.requests.length === 1, `${fake.requests.length}번`);
});

test("issues: 잘못된 필터는 badRequest 로 돌려주고 Linear 에는 안 간다", async () => {
  const { call } = make();
  const result = await call("linear.issues", { filter: { priorities: [9] } as never });
  expect(!result.ok && result.error.kind === "badRequest" && fake.requests.length === 0, JSON.stringify(result));
});

// --- 쓰기 ---
test("updateIssue: confirmed 없이는 거절 (Linear 에 아무것도 안 보낸다)", async () => {
  const { call } = make();
  for (const params of [{ id: "id-2", priority: 1 }, { id: "id-2", priority: 1, confirmed: false }, { id: "id-2", priority: 1, confirmed: "true" }]) {
    let message = "";
    await call("linear.updateIssue", params as never).catch((e: Error) => (message = e.message));
    expect(message.includes("confirmation"), `${JSON.stringify(params)}: ${message}`);
  }
  expect(fake.requests.length === 0 && fake.issues[1].priority === 2, "아무것도 바뀌지 않음");
});

test("updateIssue: 상태와 우선순위만 보내고, 바뀐 이슈를 돌려주며, 이슈 캐시를 비운다", async () => {
  const { call } = make();
  const before = await issuesOf(call, { assignee: "me" });
  expect(before.issues[1].state.name === "Todo", "전");
  const result = await call("linear.updateIssue", { id: "id-2", stateId: "s-j-doing", priority: 1, confirmed: true });
  if (!result.ok) throw new Error(JSON.stringify(result));
  expect(result.data.state.name === "In Progress" && result.data.priority === 1 && result.data.priorityLabel === "Urgent", JSON.stringify(result.data));
  const sent = fake.requests.find((r) => r.op === "LodestarIssueUpdate")!;
  expect(JSON.stringify(sent.variables) === JSON.stringify({ id: "id-2", input: { stateId: "s-j-doing", priority: 1 } }), JSON.stringify(sent.variables));
  const after = await issuesOf(call, { assignee: "me" });
  expect(after.issues.find((i) => i.id === "id-2")?.state.name === "In Progress", "30초 안인데도 새 상태가 보인다");
  const priorityOnly = await call("linear.updateIssue", { id: "id-2", priority: 0, confirmed: true });
  expect(priorityOnly.ok && priorityOnly.data.priority === 0, "우선순위만");
  expect(JSON.stringify(fake.requests[fake.requests.length - 1].variables.input) === JSON.stringify({ priority: 0 }), "stateId 는 안 보냄");
});

test("updateIssue: 값 검증 (우선순위 범위, 바꿀 것 없음, 알 수 없는 칸은 보내지 않는다)", async () => {
  const { call } = make();
  for (const params of [{ id: "id-2", priority: 7 }, { id: "id-2", priority: 1.5 }, { id: "id-2" }, { id: "", priority: 1 }, { id: "id-2", stateId: "" }]) {
    const result = await call("linear.updateIssue", { ...params, confirmed: true } as never);
    expect(!result.ok && result.error.kind === "badRequest", JSON.stringify([params, result]));
  }
  const extra = await call("linear.updateIssue", { id: "id-2", priority: 1, assigneeId: "u-other", title: "pwn", confirmed: true } as never);
  expect(extra.ok && JSON.stringify(fake.requests[fake.requests.length - 1].variables.input) === JSON.stringify({ priority: 1 }), "화면이 다른 칸을 실어도 stateId, priority 만 나간다");
  expect(fake.issues[1].assignee?.id === "u-me" && fake.issues[1].title === "Issue 2", "담당자와 제목은 그대로");
});

// --- 오류 분류 ---
test("errors: 키 없음, 401, 400 authentication error, 403, 서버 오류", async () => {
  const none = await make(null).call("linear.issues", {});
  expect(!none.ok && none.error.kind === "noKey", JSON.stringify(none));
  for (const key of [BAD401, BAD400]) {
    const r = await make(key).call("linear.issues", {});
    expect(!r.ok && r.error.kind === "invalidKey", `${key}: ${JSON.stringify(r)}`);
  }
  const forbidden = make();
  fake.mode = "forbidden";
  const f = await forbidden.call("linear.updateIssue", { id: "id-1", priority: 1, confirmed: true });
  expect(!f.ok && f.error.kind === "forbidden", JSON.stringify(f));
  const broken = make();
  fake.mode = "serverError";
  const s = await broken.call("linear.issues", {});
  expect(!s.ok && s.error.kind === "server", JSON.stringify(s));
  fake.mode = "ok";
  expect((await broken.call("linear.issues", {})).ok, "실패는 캐시하지 않는다");
});

test("errors: 닿지 않으면 network", async () => {
  const { call } = make(GOOD, env({ AGENT_NAV_LINEAR_API: "http://127.0.0.1:1" }));
  const result = await call("linear.issues", {});
  expect(!result.ok && result.error.kind === "network" && !result.error.message.includes(GOOD), JSON.stringify(result));
  const status = await call("linear.status", {});
  expect(!status.connected && status.error.kind === "network", "status 도 network");
});

test("errors: RATELIMITED 응답이면 Reset 까지 새 요청 없이 rateLimited, 지나면 다시", async () => {
  const { call } = make();
  fake.mode = "rateLimitedError";
  fake.resetAt = clock + 90_000;
  const first = await call("linear.issues", { filter: { assignee: "me" } });
  expect(!first.ok && first.error.kind === "rateLimited" && first.error.retryAfterSec === 90, JSON.stringify(first));
  fake.mode = "ok";
  const sent = fake.requests.length;
  const second = await call("linear.meta", {});
  expect(!second.ok && second.error.kind === "rateLimited" && fake.requests.length === sent, "막힌 동안은 요청을 보내지 않는다");
  clock += 30_000;
  const third = await call("linear.issues", { filter: { teamIds: ["t-ads"] } });
  expect(!third.ok && third.error.kind === "rateLimited" && third.error.retryAfterSec === 60 && fake.requests.length === sent, `retryAfterSec ${!third.ok && third.error.retryAfterSec}`);
  clock += 61_000;
  expect((await call("linear.meta", {})).ok, "지나면 다시 된다");
});

test("errors: 남은 요청 수 헤더가 0 이면 다음 요청부터 막는다", async () => {
  const { call } = make();
  fake.mode = "exhaustedHeaders";
  fake.resetAt = clock + 120_000;
  const ok = await call("linear.issues", { filter: { assignee: "me" } });
  expect(ok.ok, "이번 요청은 성공");
  const sent = fake.requests.length;
  const blocked = await call("linear.issues", { filter: { teamIds: ["t-ads"] } });
  expect(!blocked.ok && blocked.error.kind === "rateLimited" && blocked.error.retryAfterSec === 120 && fake.requests.length === sent, JSON.stringify(blocked));
  const write = await call("linear.updateIssue", { id: "id-1", priority: 2, confirmed: true });
  expect(!write.ok && write.error.kind === "rateLimited" && fake.requests.length === sent, "쓰기도 같이 막힌다");
  clock += 121_000;
  fake.mode = "ok";
  expect((await call("linear.issues", { filter: { teamIds: ["t-ads"] } })).ok, "Reset 뒤");
});

// --- 키 노출 ---
test("secret: 키는 가짜 서버의 Authorization 헤더에만 있고, 응답, 오류, 로그, 로컬 console 어디에도 없다", async () => {
  logs.length = 0;
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  const seen: string[] = [];
  const sent: typeof fake.requests = [];
  try {
    const { call } = make(null);
    seen.push(JSON.stringify(await call("linear.status", {})));
    seen.push(JSON.stringify(await call("linear.setKey", { key: BAD401, confirmed: true })));
    seen.push(JSON.stringify(await call("linear.setKey", { key: ECHO, confirmed: true })));
    seen.push(JSON.stringify(await call("linear.setKey", { key: GOOD, confirmed: true })));
    seen.push(JSON.stringify(await call("linear.status", {})));
    seen.push(JSON.stringify(await call("linear.meta", {})));
    seen.push(JSON.stringify(await call("linear.issues", { filter: { assignee: "me" } })));
    seen.push(JSON.stringify(await call("linear.updateIssue", { id: "id-2", priority: 1, confirmed: true })));
    fake.mode = "rateLimitedError";
    seen.push(JSON.stringify(await call("linear.issues", { filter: { query: "x" } })));
    seen.push(JSON.stringify(await call("linear.clearKey", { confirmed: true })));
    seen.push(JSON.stringify(await call("linear.status", {})));
    sent.push(...fake.requests);
    const failing = make(GOOD, env({ AGENT_NAV_LINEAR_API: "http://127.0.0.1:1" }));
    seen.push(JSON.stringify(await failing.call("linear.issues", {})));
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    console.warn = saved.warn;
  }
  const secrets = [GOOD, OTHER, BAD401, BAD400, ECHO];
  const everything = [...seen, ...logs].join("\n");
  for (const secret of secrets) expect(!everything.includes(secret), `${secret.slice(0, 16)}... 가 결과나 로그에 있다`);
  expect(!/lin_api_/.test(everything), "lin_api_ 접두어가 남아 있다");
  expect(logs.length > 0 && logs.every((line) => /^\[linear\] \w+ failed: \w+$/.test(line)), `로그 형식: ${logs.join(" | ")}`);
  const auths = new Set(sent.map((r) => r.auth));
  expect(auths.size >= 1 && [...auths].every((a) => a === undefined || secrets.includes(a)), "헤더는 키 그대로");
  expect(sent.length > 5 && !sent.some((r) => r.text.includes("lin_api_")), "요청 본문에는 키가 없다");
});

// --- 쓰기 보호 ---
test("guard: Linear RPC 는 모바일 허용 목록에 없고, 세션 모델에게 주는 도구 설정에도 없다", () => {
  const linearish = MOBILE_METHODS.filter((m) => /linear/i.test(m));
  expect(linearish.length === 0, linearish.join());
  const root = new URL("..", import.meta.url).pathname;
  for (const file of ["server/agents.ts", "server/claude.ts", "server/notionTools.ts", "server/notionSession.ts", "server/mobileAccess.ts", "server/mcp.ts", "server/browserTools.ts"]) {
    let text = "";
    try {
      text = readFileSync(`${root}${file}`, "utf8");
    } catch {
      continue;
    }
    expect(!/linear/i.test(text), `${file} 가 Linear 를 언급한다`);
  }
});

test("guard: 키는 AGENT_NAV_ 접두어 환경 변수라 세션 CLI 환경에서 빠진다", async () => {
  const { stripAppEnv } = await import("../server/claude");
  const out = stripAppEnv({ AGENT_NAV_LINEAR_KEY: GOOD, AGENT_NAV_LINEAR_API: BASE, PATH: "/bin" });
  expect(out.AGENT_NAV_LINEAR_KEY === undefined && out.AGENT_NAV_LINEAR_API === undefined && out.PATH === "/bin", JSON.stringify(out));
});

// --- 세션 표지와 초안 ---
test("session: 이슈 표지를 붙이고 떼며, 이상한 값은 거절한다", async () => {
  const { call, refs } = make();
  const ref = { identifier: "JOBL-1", title: "  Fix   login\ncrash ", url: "https://linear.example/issue/jobl-1" };
  expect((await call("agents.setLinearIssue", { agentId: "a1", issue: ref })) === null, "null");
  expect(JSON.stringify(refs[0]) === JSON.stringify({ agentId: "a1", issue: { identifier: "JOBL-1", title: "Fix login crash", url: "https://linear.example/issue/jobl-1" } }), JSON.stringify(refs[0]));
  await call("agents.setLinearIssue", { agentId: "a1", issue: null });
  expect(refs[1].issue === null, "떼기");
  for (const issue of [{ ...ref, identifier: "not an id" }, { ...ref, url: "javascript:alert(1)" }, { ...ref, url: "file:///etc/passwd" }]) {
    let message = "";
    await call("agents.setLinearIssue", { agentId: "a1", issue }).catch((e: Error) => (message = e.message));
    expect(message !== "", JSON.stringify(issue));
  }
  expect(refs.length === 2 && fake.requests.length === 0, "표지는 로컬 전용이라 Linear 를 부르지 않는다");
});

test("draft: linearIssueDraft 는 식별자, 제목, URL, 상태와 우선순위와 라벨, 설명 순서", async () => {
  const { call } = make();
  const issues = await issuesOf(call, { assignee: "me" });
  const draft = linearIssueDraft(issues.issues[0]);
  expect(draft.sessionTitle === "JOBL-1 Fix login crash", draft.sessionTitle);
  expect(draft.prompt === "JOBL-1: Fix login crash\nhttps://linear.example/issue/jobl-1\nStatus: In Progress, Priority: Urgent, Labels: FE\n\nDescription 1", JSON.stringify(draft.prompt));
  const cut = linearIssueDraft((await issuesOf(call, { assignee: "u-other" })).issues[0]);
  expect(cut.prompt.endsWith("(The description is cut off. Open the issue for the rest.)"), cut.prompt.slice(-80));
  const bare = linearIssueDraft({ ...issues.issues[1], description: null, labels: [] });
  expect(bare.prompt === "JOBL-2: Issue 2\nhttps://linear.example/issue/jobl-2\nStatus: Todo, Priority: High", JSON.stringify(bare.prompt));
  expect(linearIssueDraft({ ...issues.issues[0], title: "t".repeat(500) }).sessionTitle.length === 200, "제목 길이 상한");
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
server.close();
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
