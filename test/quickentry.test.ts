import { acceleratorFromKeyStroke, acceleratorLabel, clampQuickHeight, normalizeQuickEntryConfig, parseAccelerator, pickWorkArea, QUICK_ENTRY_DEFAULT_SHORTCUT, QuickShortcutController, quickEntryBounds, quickInputPolicy, quickShortcutBlocked, type Rect, type ShortcutRegistry } from "../shared/quickEntry";
import { canQuickSend, defaultTarget, parseDraft, planQuickSend, quickDefaults, quickKeyAction, recentSessions, targetLabel, targetRows, validTarget, workspacesByRecency, type QuickKeyEvent } from "../web/quickEntryModel";
import type { Agent, Workspace } from "../shared/protocol";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("parseAccelerator: 정리된 모양으로, 수정키 순서와 대소문자와 별칭", () => {
  expect(parseAccelerator("Alt+C") === "Alt+C", "기본값");
  expect(parseAccelerator("alt+c") === "Alt+C", "소문자");
  expect(parseAccelerator("Option+C") === "Alt+C", "Option 별칭");
  expect(parseAccelerator("shift+ctrl+alt+space") === "Control+Alt+Shift+Space", "순서와 이름 정리");
  expect(parseAccelerator("Cmd+Shift+K") === "Command+Shift+K", "Cmd");
  expect(parseAccelerator("CmdOrCtrl+Shift+Space") === "CommandOrControl+Shift+Space", "CommandOrControl");
  expect(parseAccelerator("Alt+F13") === "Alt+F13" && parseAccelerator("Alt+f5") === "Alt+F5", "F 키");
  expect(parseAccelerator("Alt+1") === "Alt+1" && parseAccelerator("Control+,") === "Control+,", "숫자와 구두점");
  return "ok";
});

test("parseAccelerator: 글자만 치는 조합과 깨진 문자열은 거절", () => {
  expect(parseAccelerator("C") === null, "수정키 없음");
  expect(parseAccelerator("Shift+C") === null, "Shift 만으로는 대문자 입력과 같다");
  expect(parseAccelerator("Alt") === null && parseAccelerator("Alt+") === null && parseAccelerator("+C") === null, "키 없음");
  expect(parseAccelerator("Alt+Alt+C") === null, "수정키 중복");
  expect(parseAccelerator("Hyper+C") === null && parseAccelerator("Alt+Nope") === null, "모르는 이름");
  expect(parseAccelerator("Alt+F25") === null, "F25 는 없다");
  expect(parseAccelerator("") === null && parseAccelerator(null) === null && parseAccelerator(42) === null, "문자열이 아님");
  return "ok";
});

test("acceleratorFromKeyStroke: 글자는 code 로 읽는다(⌥C 의 key 는 ç)", () => {
  const stroke = (code: string, extra: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => acceleratorFromKeyStroke({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
  expect(stroke("KeyC", { altKey: true }) === "Alt+C", "Option+C");
  expect(stroke("Space", { ctrlKey: true, altKey: true }) === "Control+Alt+Space", "Ctrl+Option+Space");
  expect(stroke("KeyC", { altKey: true, shiftKey: true }) === "Alt+Shift+C", "Shift 포함");
  expect(stroke("KeyC") === null && stroke("KeyC", { shiftKey: true }) === null, "수정키 없음 거절");
  expect(stroke("AltLeft", { altKey: true }) === null && stroke("ShiftLeft", { shiftKey: true }) === null, "수정키만 누름");
  expect(stroke("Digit1", { altKey: true }) === "Alt+1" && stroke("F5", { ctrlKey: true }) === "Control+F5", "숫자와 F 키");
  return "ok";
});

test("acceleratorLabel: macOS 표기 순서 ⌃⌥⇧⌘", () => {
  expect(acceleratorLabel("Alt+C") === "⌥C", "⌥C");
  expect(acceleratorLabel("Control+Alt+Shift+Space") === "⌃⌥⇧Space", "순서");
  expect(acceleratorLabel("CommandOrControl+Shift+Space") === "⇧⌘Space", "Cmd");
  expect(acceleratorLabel("Alt+Up") === "⌥↑", "화살표");
  return "ok";
});

test("normalizeQuickEntryConfig: 없거나 깨진 값은 켬과 ⌥C", () => {
  const fallback = { enabled: true, accelerator: QUICK_ENTRY_DEFAULT_SHORTCUT };
  expect(JSON.stringify(normalizeQuickEntryConfig(undefined)) === JSON.stringify(fallback), "undefined");
  expect(JSON.stringify(normalizeQuickEntryConfig({ enabled: "no", accelerator: "C" })) === JSON.stringify(fallback), "깨진 값");
  const off = normalizeQuickEntryConfig({ enabled: false, accelerator: "option+space" });
  expect(!off.enabled && off.accelerator === "Alt+Space", "끔과 정리된 단축키");
  return "ok";
});

function fakeRegistry(options: { taken?: string[]; throws?: string[] } = {}) {
  const calls: string[] = [];
  const held = new Set<string>();
  const registry: ShortcutRegistry = {
    register(accelerator) {
      calls.push(`register ${accelerator}`);
      if (options.throws?.includes(accelerator)) throw new Error("invalid accelerator");
      if (options.taken?.includes(accelerator)) return false;
      held.add(accelerator);
      return true;
    },
    unregister(accelerator) {
      calls.push(`unregister ${accelerator}`);
      held.delete(accelerator);
    },
  };
  return { registry, calls, held };
}

test("컨트롤러: 켜면 등록하고, 같은 설정이 다시 오면 다시 등록하지 않는다", () => {
  const { registry, calls } = fakeRegistry();
  const controller = new QuickShortcutController(registry, () => undefined, false);
  const first = controller.apply({ enabled: true, accelerator: "alt+c" });
  expect(first.state === "registered" && first.accelerator === "Alt+C", "등록됨, 정리된 이름");
  controller.apply({ enabled: true, accelerator: "Alt+C" });
  expect(calls.join() === "register Alt+C", "한 번만 등록");
  return "ok";
});

test("컨트롤러: 단축키를 바꾸면 옛 것을 풀고 새 것을 등록", () => {
  const { registry, calls, held } = fakeRegistry();
  const controller = new QuickShortcutController(registry, () => undefined, false);
  controller.apply({ enabled: true, accelerator: "Alt+C" });
  const next = controller.apply({ enabled: true, accelerator: "Alt+Space" });
  expect(next.state === "registered" && next.accelerator === "Alt+Space", "새 단축키");
  expect(calls.join() === "register Alt+C,unregister Alt+C,register Alt+Space" && [...held].join() === "Alt+Space", "옛 것 해제 뒤 등록");
  return "ok";
});

test("컨트롤러: 끄면 풀고 off, 다시 켜면 등록", () => {
  const { registry, held } = fakeRegistry();
  const controller = new QuickShortcutController(registry, () => undefined, false);
  controller.apply({ enabled: true, accelerator: "Alt+C" });
  const off = controller.apply({ enabled: false, accelerator: "Alt+C" });
  expect(off.state === "off" && held.size === 0, "해제");
  expect(controller.apply({ enabled: true, accelerator: "Alt+C" }).state === "registered" && held.has("Alt+C"), "재등록");
  return "ok";
});

test("컨트롤러: 다른 앱이 쓰고 있으면 failed(taken), 같은 설정으로 다시 시도하면 재등록 시도", () => {
  const taken = ["Alt+C"];
  const { registry, calls } = fakeRegistry({ taken });
  const controller = new QuickShortcutController(registry, () => undefined, false);
  const first = controller.apply({ enabled: true, accelerator: "Alt+C" });
  expect(first.state === "failed" && first.reason === "taken" && first.accelerator === "Alt+C", "taken");
  taken.length = 0;
  const retry = controller.apply({ enabled: true, accelerator: "Alt+C" });
  expect(retry.state === "registered", "다른 앱이 놓은 뒤 다시 시도하면 등록");
  expect(calls.filter((c) => c === "register Alt+C").length === 2, "실패 상태에서는 다시 시도");
  return "ok";
});

test("컨트롤러: register 가 던지거나 문자열이 깨졌으면 failed(invalid)", () => {
  const { registry } = fakeRegistry({ throws: ["Alt+Space"] });
  const controller = new QuickShortcutController(registry, () => undefined, false);
  const thrown = controller.apply({ enabled: true, accelerator: "Alt+Space" });
  expect(thrown.state === "failed" && thrown.reason === "invalid", "던짐");
  const broken = controller.apply({ enabled: true, accelerator: "Shift+C" });
  expect(broken.state === "failed" && broken.reason === "invalid", "수정키 없음");
  return "ok";
});

test("컨트롤러: 실패한 새 단축키는 옛 단축키를 남기지 않는다", () => {
  const { registry, held } = fakeRegistry({ taken: ["Alt+Space"] });
  const controller = new QuickShortcutController(registry, () => undefined, false);
  controller.apply({ enabled: true, accelerator: "Alt+C" });
  const failed = controller.apply({ enabled: true, accelerator: "Alt+Space" });
  expect(failed.state === "failed" && held.size === 0, "옛 것도 풀린 채 실패 표시");
  return "ok";
});

test("컨트롤러: 시험 인스턴스(blocked)는 어떤 설정에도 register 를 부르지 않는다", () => {
  const { registry, calls } = fakeRegistry();
  const controller = new QuickShortcutController(registry, () => undefined, true);
  expect(controller.status.state === "blocked", "처음부터 blocked");
  const status = controller.apply({ enabled: true, accelerator: "Alt+C" });
  controller.apply({ enabled: true, accelerator: "Alt+Space" });
  controller.apply({ enabled: false, accelerator: "Alt+C" });
  controller.release();
  expect(status.state === "blocked" && status.reason === "test-instance", "blocked 와 이유");
  expect(calls.length === 0, `registry 호출 없음: ${calls.join()}`);
  return "ok";
});

test("컨트롤러: release 는 등록한 것만 푼다", () => {
  const { registry, calls } = fakeRegistry({ taken: ["Alt+C"] });
  const controller = new QuickShortcutController(registry, () => undefined, false);
  controller.apply({ enabled: true, accelerator: "Alt+C" });
  controller.release();
  expect(!calls.some((c) => c.startsWith("unregister")), "등록 실패한 것은 풀지 않는다");
  const ok = fakeRegistry();
  const c2 = new QuickShortcutController(ok.registry, () => undefined, false);
  c2.apply({ enabled: true, accelerator: "Alt+C" });
  c2.release();
  expect(ok.held.size === 0, "등록한 것은 푼다");
  return "ok";
});

test("quickShortcutBlocked: INACTIVE, 창구, 전용 환경변수 중 하나면 막는다", () => {
  expect(quickShortcutBlocked({}, false) === false, "평소엔 등록");
  expect(quickShortcutBlocked({ AGENT_NAV_INACTIVE: "1" }, false), "AGENT_NAV_INACTIVE=1");
  expect(quickShortcutBlocked({}, true), "창구가 켜진 실행");
  expect(quickShortcutBlocked({ AGENT_NAV_NO_GLOBAL_SHORTCUT: "1" }, false), "AGENT_NAV_NO_GLOBAL_SHORTCUT=1");
  expect(quickShortcutBlocked({ AGENT_NAV_INACTIVE: "0", AGENT_NAV_NO_GLOBAL_SHORTCUT: "" }, false) === false, "0 과 빈 값은 막지 않는다");
  return "ok";
});

const left: Rect = { x: 0, y: 25, width: 1440, height: 875 };
const right: Rect = { x: 1440, y: 0, width: 1920, height: 1080 };

test("pickWorkArea: 커서가 든 화면, 밖이면 가장 가까운 화면", () => {
  expect(pickWorkArea([left, right], { x: 100, y: 100 }) === left, "왼쪽 화면");
  expect(pickWorkArea([left, right], { x: 2000, y: 500 }) === right, "오른쪽 화면");
  expect(pickWorkArea([left, right], { x: 1440, y: 10 }) === right, "경계는 오른쪽 화면");
  expect(pickWorkArea([left, right], { x: -50, y: 1500 }) === left, "밖에서는 가까운 쪽");
  expect(pickWorkArea([], { x: 0, y: 0 }) === null, "화면 없음");
  return "ok";
});

test("quickEntryBounds: 가로 가운데, 윗변은 높이의 topRatio, 높이가 늘어도 윗변 유지", () => {
  const options = { topRatio: 0.2, pad: 32 };
  const small = quickEntryBounds(left, { width: 744, height: 124 }, options);
  expect(small.x === Math.round((1440 - 744) / 2) && small.width === 744, `가운데: x=${small.x}`);
  expect(small.y === 25 + 175 - 32, `카드 윗변이 작업 영역 20% 지점: y=${small.y}`);
  const tall = quickEntryBounds(left, { width: 744, height: 584 }, options);
  expect(tall.y === small.y && tall.height === 584, "높이가 늘어도 같은 y");
  const second = quickEntryBounds(right, { width: 744, height: 124 }, options);
  expect(second.x === 1440 + Math.round((1920 - 744) / 2), `둘째 화면 가운데: x=${second.x}`);
  return "ok";
});

test("quickEntryBounds: 작업 영역 아래를 넘으면 위로 당기고, 영역보다 큰 창은 줄인다", () => {
  const options = { topRatio: 0.2, pad: 32 };
  const pulled = quickEntryBounds({ x: 0, y: 0, width: 1000, height: 600 }, { width: 744, height: 560 }, options);
  expect(pulled.y + pulled.height <= 600 && pulled.y >= 0, `안에 든다: y=${pulled.y}`);
  const shrunk = quickEntryBounds({ x: 0, y: 0, width: 500, height: 300 }, { width: 744, height: 584 }, options);
  expect(shrunk.width === 500 && shrunk.height === 300 && shrunk.x === 0 && shrunk.y === 0, "영역 크기로 줄인다");
  return "ok";
});

test("clampQuickHeight: 최소 한 줄, 최대 상한, 작업 영역 높이", () => {
  const limits = { min: 124, max: 584 };
  expect(clampQuickHeight(10, limits, left) === 124, "최소");
  expect(clampQuickHeight(300.4, limits, left) === 300, "반올림");
  expect(clampQuickHeight(9999, limits, left) === 584, "최대");
  expect(clampQuickHeight(9999, limits, { x: 0, y: 0, width: 800, height: 400 }) === 400, "작은 화면");
  expect(clampQuickHeight(Number.NaN, limits, null) === 124, "NaN");
  return "ok";
});

test("quickInputPolicy: 편집 키는 통과, 메뉴 가속키는 막고, ⌘W 는 창을 숨긴다", () => {
  const key = (k: string, mods: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = {}) => quickInputPolicy({ key: k, meta: false, control: false, alt: false, shift: false, ...mods });
  expect(key("a") === "allow" && key("Enter") === "allow" && key("Escape") === "allow", "그냥 글자와 Enter, Esc");
  expect(key("Enter", { meta: true }) === "allow", "⌘Enter 는 페이지가 받는다");
  expect(["c", "v", "x", "a", "z"].every((k) => key(k, { meta: true }) === "allow"), "⌘C V X A Z");
  expect(key("w", { meta: true }) === "hide", "⌘W");
  expect(key("n", { meta: true }) === "block" && key("r", { meta: true }) === "block" && key("p", { meta: true }) === "block", "⌘N, R, P 는 메인 창으로 새지 않게 막는다");
  expect(key("h", { alt: true }) === "block" && key("r", { control: true, alt: true }) === "block", "⌥H, ⌃⌥R");
  expect(key("ArrowDown", { alt: true }) === "allow" && key("Backspace", { alt: true }) === "allow", "⌥↓ 와 ⌥⌫ 는 입력칸 동작");
  const real = (k: string, code: string, mods: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }>) => quickInputPolicy({ key: k, code, meta: false, control: false, alt: false, shift: false, ...mods });
  expect(real("ㅊ", "KeyC", { meta: true }) === "allow" && real("ㅍ", "KeyV", { meta: true }) === "allow" && real("ㅋ", "KeyZ", { meta: true }) === "allow", "한글 입력의 ⌘C, ⌘V, ⌘Z");
  expect(real("ㅈ", "KeyW", { meta: true }) === "hide", "한글 입력의 ⌘W");
  expect(real("ㅜ", "KeyN", { meta: true }) === "block", "한글 입력의 ⌘N 도 막는다");
  expect(real("˙", "KeyH", { alt: true }) === "block", "⌥H(key ˙)는 메뉴의 Attach 로 새지 않게 막는다");
  expect(real("c", "KeyJ", { meta: true }) === "allow", "Dvorak 처럼 key 가 로마자면 key 를 따른다");
  expect(real("M", "KeyM", { meta: true, shift: true }) === "forward" && real("ㅑ", "KeyI", { meta: true, shift: true }) === "forward", "⇧⌘M, ⇧⌘I 는 페이지로 넘긴다");
  expect(real("m", "KeyM", { meta: true }) === "block", "⌘M 은 그대로 막는다");
  expect(real("1", "Digit1", { meta: true }) === "allow" && real("¡", "Digit1", { meta: true, alt: true }) === "allow" && real("!", "Digit1", { meta: true, shift: true }) === "block", "⌘1, ⌥⌘1 은 모델 목록이 받는다");
  return "ok";
});

const ws = (id: string, name: string, extra: Partial<Workspace> = {}): Workspace => ({ id, name, dir: `/Users/me/Repository/${name}`, parentId: null, ...extra });
const agent = (id: string, workspaceId: string | null, updatedAt: string, extra: Partial<Agent> = {}): Agent => ({ id, workspaceId, title: `session ${id}`, updatedAt, createdAt: updatedAt, feedbackId: null, ...extra }) as Agent;

const WORKSPACES = [ws("w1", "jobs"), ws("w2", "agent-nav"), ws("w3", "notes"), ws("w1-wt", "jobs-feature", { parentId: "w1" }), ws("wf", "feedback", { feedback: true })];

test("workspacesByRecency: 최상위만, 세션이 늦은 순(worktree 세션은 원래 프로젝트로 센다), 세션 없는 폴더는 뒤", () => {
  const agents = [agent("a1", "w2", "2026-10-18T10:00:00Z"), agent("a2", "w1-wt", "2026-10-19T09:00:00Z"), agent("a3", "w1", "2026-10-17T10:00:00Z")];
  const order = workspacesByRecency(WORKSPACES, agents).map((w) => w.id);
  expect(order.join() === "w1,w2,w3", `worktree 세션이 jobs 를 끌어올린다: ${order.join()}`);
  expect(workspacesByRecency(WORKSPACES, []).map((w) => w.id).join() === "w1,w2,w3", "세션이 없으면 원래 순서");
  const feedbackOnly = workspacesByRecency(WORKSPACES, [agent("f1", "w3", "2026-10-20T10:00:00Z", { feedbackId: "fb" })]);
  expect(feedbackOnly[0].id === "w1", "피드백 개선 세션은 최근에 세지 않는다");
  return "ok";
});

test("recentSessions: 보관과 피드백 세션을 빼고 최근 순으로 5개", () => {
  const agents = Array.from({ length: 7 }, (_, i) => agent(`a${i}`, "w1", `2026-10-1${i}T10:00:00Z`));
  agents.push(agent("done", "w1", "2026-10-30T10:00:00Z", { done: true }), agent("fb", "w1", "2026-10-30T11:00:00Z", { feedbackId: "x" }));
  const recent = recentSessions(agents).map((a) => a.id);
  expect(recent.join() === "a6,a5,a4,a3,a2", `상위 5개: ${recent.join()}`);
  return "ok";
});

test("defaultTarget 과 validTarget: 기본은 빠른 채팅, 지워진 대상은 기본으로", () => {
  const agents = [agent("a1", "w2", "2026-10-18T10:00:00Z")];
  const base = defaultTarget(WORKSPACES, agents);
  expect(base.kind === "chat", "기본은 폴더 없는 빠른 채팅");
  expect(defaultTarget([], []).kind === "chat", "폴더 없음");
  expect(validTarget({ kind: "chat" }, WORKSPACES, agents).kind === "chat", "빠른 채팅은 늘 유효");
  expect(validTarget({ kind: "new", workspaceId: "gone" }, WORKSPACES, agents).kind === "chat", "지워진 폴더");
  const gone = validTarget({ kind: "new", workspaceId: "gone" }, WORKSPACES, agents);
  expect(gone.kind === "chat", "기본으로 되돌린다");
  expect(validTarget({ kind: "new", workspaceId: "w1-wt" }, WORKSPACES, agents).kind === "chat", "worktree 워크스페이스는 대상이 아니다");
  expect(validTarget({ kind: "session", agentId: "a1" }, WORKSPACES, agents).kind === "session", "남아 있는 세션");
  expect(validTarget({ kind: "session", agentId: "zzz" }, WORKSPACES, agents).kind === "chat", "지워진 세션");
  expect(validTarget(null, WORKSPACES, agents).kind === "chat", "저장된 대상 없음");
  return "ok";
});

test("targetRows: 폴더, 빠른 채팅, 최근 세션 순서이고 고른 폴더가 상한 밖이어도 들어간다", () => {
  const many = Array.from({ length: 9 }, (_, i) => ws(`m${i}`, `proj${i}`));
  const rows = targetRows(many, [agent("s1", "m0", "2026-10-18T10:00:00Z")], { kind: "new", workspaceId: "m8" });
  const sections = rows.map((r) => r.section).join();
  expect(sections === "new,new,new,new,new,new,new,chat,session", `구성: ${sections}`);
  expect(rows[0].target.kind === "new" && (rows[0].target as { workspaceId: string }).workspaceId === "m8", "고른 폴더가 맨 앞");
  expect(rows.find((r) => r.section === "chat")?.target.kind === "chat", "빠른 채팅 줄");
  const session = rows[rows.length - 1];
  expect(session.hint === "proj0" && session.target.kind === "session", "세션 줄 힌트는 폴더 이름");
  expect(rows[1].hint === "~/Repository/proj0" || rows[1].hint.startsWith("~/"), `홈은 ~ 로: ${rows[1].hint}`);
  return "ok";
});

test("targetLabel: 알약에 적히는 이름", () => {
  const agents = [agent("a1", "w1", "2026-10-18T10:00:00Z", { title: "Fix login" })];
  expect(targetLabel({ kind: "chat" }, WORKSPACES, agents) === "Chat", "chat");
  expect(targetLabel({ kind: "new", workspaceId: "w1" }, WORKSPACES, agents) === "New in jobs", "new");
  expect(targetLabel({ kind: "session", agentId: "a1" }, WORKSPACES, agents) === "Reply in Fix login", "session");
  return "ok";
});

const DEFAULTS = { permissionMode: "default" as const, model: null, effort: null };

test("planQuickSend: 새 세션과 빠른 채팅은 agents.create, 이어 보내기는 agents.send", () => {
  const created = planQuickSend({ target: { kind: "new", workspaceId: "w1" }, text: "  fix it  ", imageCount: 0, defaults: { permissionMode: "acceptEdits", model: "haiku", effort: "low" } });
  expect(created?.method === "agents.create", "create");
  if (created?.method !== "agents.create") throw new Error("unreachable");
  expect(created.params.workspaceId === "w1" && created.params.prompt === "fix it" && created.params.worktree === null, "워크스페이스와 다듬은 글, worktree 없음");
  expect(created.params.permissionMode === "acceptEdits" && created.params.model === "haiku" && created.params.effort === "low", "기본값 그대로");
  const chat = planQuickSend({ target: { kind: "chat" }, text: "hi", imageCount: 0, defaults: DEFAULTS });
  expect(chat?.method === "agents.create" && chat.params.workspaceId === null, "빠른 채팅은 workspaceId null");
  const send = planQuickSend({ target: { kind: "session", agentId: "a1" }, text: "more", imageCount: 0, defaults: DEFAULTS });
  expect(send?.method === "agents.send" && send.params.agentId === "a1" && send.params.prompt === "more", "send");
  return "ok";
});

test("planQuickSend: 글도 이미지도 없으면 보낼 게 없고, 이미지만 있어도 보낸다", () => {
  expect(planQuickSend({ target: { kind: "chat" }, text: "   \n", imageCount: 0, defaults: DEFAULTS }) === null, "빈 글");
  const imageOnly = planQuickSend({ target: { kind: "chat" }, text: "", imageCount: 1, defaults: DEFAULTS });
  expect(imageOnly?.method === "agents.create" && imageOnly.params.prompt === "", "이미지만");
  return "ok";
});

test("quickDefaults: 데몬이 해석한 값 > 고른 값 > 내장값", () => {
  const settings = { defaultModel: "sonnet", defaultEffort: "high" as const, defaultPermissionMode: "plan" as const };
  const resolved = { model: { value: "opus", source: "vscode" }, effort: { value: null, source: "builtin" }, permissionMode: { value: "auto", source: "claude" } } as never;
  const fromResolved = quickDefaults(settings, resolved);
  expect(fromResolved.model === "opus" && fromResolved.permissionMode === "auto", "해석된 값");
  const fromSettings = quickDefaults(settings, null);
  expect(fromSettings.model === "sonnet" && fromSettings.effort === "high" && fromSettings.permissionMode === "plan", "settings 값");
  const builtin = quickDefaults(null, null);
  expect(builtin.model === null && builtin.effort === null && builtin.permissionMode === "default", "내장값");
  return "ok";
});

const key = (k: string, extra: Partial<QuickKeyEvent> = {}): QuickKeyEvent => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...extra });

test("quickKeyAction: Enter 는 보내고 열기, ⌘Enter 는 보내고 머물기, Shift+Enter 는 줄바꿈", () => {
  expect(quickKeyAction(key("Enter")) === "send-open", "Enter");
  expect(quickKeyAction(key("Enter", { metaKey: true })) === "send-stay", "⌘Enter");
  expect(quickKeyAction(key("Enter", { ctrlKey: true })) === "send-stay", "Ctrl+Enter 도 머물기");
  expect(quickKeyAction(key("Enter", { shiftKey: true })) === "newline", "Shift+Enter");
  expect(quickKeyAction(key("Enter", { shiftKey: true, metaKey: true })) === "send-stay", "⌘ 가 있으면 Shift 와 상관없이 보내기");
  return "ok";
});

test("quickKeyAction: 한글 조합 중의 Enter 는 보내지 않는다", () => {
  expect(quickKeyAction(key("Enter", { isComposing: true })) === "none", "isComposing");
  expect(quickKeyAction(key("Enter", { keyCode: 229 })) === "none", "keyCode 229");
  expect(quickKeyAction(key("Escape", { isComposing: true })) === "none", "조합 중 Esc 는 조합 취소");
  return "ok";
});

test("quickKeyAction: Esc 는 닫기, ⌥↓ 는 대상 목록, 그 밖의 키는 none", () => {
  expect(quickKeyAction(key("Escape")) === "close", "Esc");
  expect(quickKeyAction(key("ArrowDown", { altKey: true })) === "menu", "⌥↓");
  expect(quickKeyAction(key("ArrowDown")) === "none", "↓ 만으로는 입력칸 동작");
  expect(quickKeyAction(key("a")) === "none", "글자");
  return "ok";
});

test("canQuickSend: 연결됨, 바쁘지 않음, 글이나 이미지가 있어야", () => {
  expect(canQuickSend({ connected: true, busy: false, text: "hi", imageCount: 0 }), "글");
  expect(canQuickSend({ connected: true, busy: false, text: " ", imageCount: 1 }), "이미지");
  expect(!canQuickSend({ connected: false, busy: false, text: "hi", imageCount: 0 }), "데몬이 꺼져 있으면 못 보낸다");
  expect(!canQuickSend({ connected: true, busy: true, text: "hi", imageCount: 0 }), "보내는 중");
  expect(!canQuickSend({ connected: true, busy: false, text: "  ", imageCount: 0 }), "빈 글");
  return "ok";
});

test("parseDraft: 저장해 둔 글과 대상, 깨졌으면 빈 초안", () => {
  const saved = parseDraft(JSON.stringify({ text: "half written", target: { kind: "new", workspaceId: "w1" } }));
  expect(saved.text === "half written" && saved.target?.kind === "new", "복원");
  expect(parseDraft(JSON.stringify({ text: "x", target: { kind: "session", agentId: "a1" } })).target?.kind === "session", "세션 대상");
  expect(parseDraft(JSON.stringify({ text: "x", target: { kind: "new" } })).target === null, "필드가 빠진 대상");
  const broken = parseDraft("{not json");
  expect(broken.text === "" && broken.target === null, "깨진 JSON");
  expect(parseDraft(null).text === "", "없음");
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`PASS ${c.name}: ${c.run()}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}: ${(e as Error).message}`);
  }
}
if (failed) process.exit(1);
console.log(`${cases.length} passed`);
