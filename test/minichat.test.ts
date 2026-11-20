// 미니 채팅 패널의 순수 규칙 단독 시험: 런처와 대화 전환, 핀과 blur, 저장한 자리 보정, 알림 대상, 저장 파일. 실행: npm test
import { afterNew, afterSend, barFromChat, blurAction, fitChatBounds, growFromBar, MINI_INITIAL, miniUrl, modeFor, notificationTarget, parseMiniSaved, pinnedFromSetting, sameRect, serializeMiniSaved, stateFor, type Rect } from "../shared/miniChat";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const MIN = { width: 344, height: 264 };
const SCREEN_A: Rect = { x: 0, y: 25, width: 1440, height: 875 };
const SCREEN_B: Rect = { x: 1440, y: 0, width: 1920, height: 1080 };

// --- 런처와 대화 ---

test("modeFor / stateFor: 묶인 세션이 있으면 대화, 없으면 입력 막대", () => {
  expect(modeFor(null) === "launcher" && modeFor("a1") === "chat", "모드");
  expect(eq(stateFor("a1"), { mode: "chat", agentId: "a1" }) && eq(stateFor(null), MINI_INITIAL), "상태");
  return "ok";
});

test("afterSend: Enter 는 대화로 커지고, ⌘Enter 는 대화를 묶고 숨긴다", () => {
  const grow = afterSend("a1", false);
  expect(grow.state.mode === "chat" && grow.state.agentId === "a1" && !grow.hide, "Enter");
  const stay = afterSend("a2", true);
  expect(stay.state.mode === "chat" && stay.state.agentId === "a2" && stay.hide, "⌘Enter");
  return "ok";
});

test("afterNew: 새 미니 대화는 세션을 풀고 입력 막대로", () => {
  expect(eq(afterNew(), { mode: "launcher", agentId: null }), "초기");
  return "ok";
});

test("miniUrl: 런처는 ?view=quick, 대화는 단일 세션 화면에 mini=1", () => {
  expect(miniUrl("http://127.0.0.1:7788", null) === "http://127.0.0.1:7788/?view=quick", "런처");
  expect(miniUrl("http://127.0.0.1:7788", "a 1/x") === "http://127.0.0.1:7788/?embed=session&agent=a%201%2Fx&mini=1", "대화는 id 를 인코딩");
  expect(miniUrl("http://x", "a1", "light") === "http://x/?embed=session&agent=a1&mini=1&theme=light" && miniUrl("http://x", null, "dark") === "http://x/?view=quick&theme=dark", "첫 화면 테마");
  return "ok";
});

// --- blur ---

test("blurAction: 입력 막대는 늘 blur 로 숨는다", () => {
  const base = { mode: "launcher" as const, pinned: true, inactive: false, sinceShownMs: 1000, guardMs: 250 };
  expect(blurAction(base) === "hide", "핀이어도 입력 막대는 숨김");
  return "ok";
});

test("blurAction: 대화는 핀이면 유지, 핀을 풀면 숨김", () => {
  const base = { mode: "chat" as const, pinned: true, inactive: false, sinceShownMs: 1000, guardMs: 250 };
  expect(blurAction(base) === "keep", "핀: 바깥을 눌러도 유지");
  expect(blurAction({ ...base, pinned: false }) === "hide", "핀 해제: 숨김");
  return "ok";
});

test("blurAction: 뜬 직후 흔들림과 시험 인스턴스는 무시", () => {
  const base = { mode: "chat" as const, pinned: false, inactive: false, sinceShownMs: 100, guardMs: 250 };
  expect(blurAction(base) === "keep", "250ms 안");
  expect(blurAction({ ...base, sinceShownMs: 250 }) === "keep" && blurAction({ ...base, sinceShownMs: 251 }) === "hide", "경계");
  expect(blurAction({ ...base, sinceShownMs: 5000, inactive: true }) === "keep", "inactive");
  return "ok";
});

test("pinnedFromSetting: Hide on outside click 이 꺼져 있으면(기본) 고정", () => {
  expect(pinnedFromSetting(undefined) && pinnedFromSetting(false) && !pinnedFromSetting(true), "기본 고정");
  return "ok";
});

// --- 알림 ---

test("notificationTarget: 미니 대화의 세션만 갈라진다", () => {
  expect(notificationTarget({ agentId: "a1", miniAgentId: null, miniVisible: false }) === "default", "묶인 대화 없음");
  expect(notificationTarget({ agentId: "a2", miniAgentId: "a1", miniVisible: false }) === "default", "다른 세션");
  expect(notificationTarget({ agentId: "a1", miniAgentId: "a1", miniVisible: true }) === "suppress", "보이는 중이면 알림 없음");
  expect(notificationTarget({ agentId: "a1", miniAgentId: "a1", miniVisible: false }) === "mini", "숨겨져 있으면 알리고 미니 패널로");
  return "ok";
});

// --- 저장 파일 ---

test("parseMiniSaved: 깨진 파일은 빈 값, 자리는 정수로", () => {
  expect(eq(parseMiniSaved(null), { bounds: null, agentId: null }), "없음");
  expect(eq(parseMiniSaved("{nope"), { bounds: null, agentId: null }), "깨진 JSON");
  const ok = parseMiniSaved(JSON.stringify({ bounds: { x: 10.4, y: 20.6, width: 420, height: 560 }, agentId: "a1" }));
  expect(eq(ok, { bounds: { x: 10, y: 21, width: 420, height: 560 }, agentId: "a1" }), "반올림");
  expect(parseMiniSaved(JSON.stringify({ bounds: { x: 1, y: 2, width: 0, height: 5 } })).bounds === null, "폭 0");
  expect(parseMiniSaved(JSON.stringify({ bounds: { x: "1", y: 2, width: 3, height: 4 } })).bounds === null, "숫자가 아님");
  expect(parseMiniSaved(JSON.stringify({ agentId: "" })).agentId === null && parseMiniSaved(JSON.stringify({ agentId: 7 })).agentId === null, "id 모양");
  const round = parseMiniSaved(serializeMiniSaved({ bounds: { x: 1, y: 2, width: 3, height: 4 }, agentId: "z" }));
  expect(eq(round, { bounds: { x: 1, y: 2, width: 3, height: 4 }, agentId: "z" }), "왕복");
  return "ok";
});

// --- 자리 보정 ---

test("fitChatBounds: 보이는 자리는 그대로", () => {
  const saved = { x: 500, y: 100, width: 484, height: 624 };
  expect(eq(fitChatBounds(saved, [SCREEN_A, SCREEN_B], SCREEN_A, MIN), saved), "그대로");
  return "ok";
});

test("fitChatBounds: 모니터를 뺐으면(저장 자리가 없는 화면) 남은 화면으로", () => {
  const saved = { x: 2000, y: 200, width: 484, height: 624 };
  const fitted = fitChatBounds(saved, [SCREEN_A], SCREEN_A, MIN);
  expect(fitted.x === SCREEN_A.x + SCREEN_A.width - 484 && fitted.y === 200 && fitted.width === 484, `오른쪽 끝으로 당김 ${JSON.stringify(fitted)}`);
  return "ok";
});

test("fitChatBounds: 작업 영역을 넘은 크기는 줄이고, 최소보다 작은 크기는 키운다", () => {
  const huge = fitChatBounds({ x: 0, y: 0, width: 5000, height: 5000 }, [SCREEN_A], SCREEN_A, MIN);
  expect(huge.width === 1440 && huge.height === 875 && huge.x === 0 && huge.y === 25, "작업 영역에 맞춤");
  const tiny = fitChatBounds({ x: 100, y: 100, width: 10, height: 10 }, [SCREEN_A], SCREEN_A, MIN);
  expect(tiny.width === 344 && tiny.height === 264, "최소 크기");
  return "ok";
});

test("fitChatBounds: 두 화면에 걸쳤으면 더 많이 겹치는 화면 안으로", () => {
  const straddle = { x: 1150, y: 100, width: 484, height: 624 };
  const fitted = fitChatBounds(straddle, [SCREEN_A, SCREEN_B], SCREEN_A, MIN);
  expect(fitted.x === 956 && fitted.x + fitted.width <= SCREEN_A.x + SCREEN_A.width, "A 와 290px, B 와 194px 겹쳐서 A 안으로 " + JSON.stringify(fitted));
  const other = fitChatBounds({ x: 1300, y: 100, width: 484, height: 624 }, [SCREEN_A, SCREEN_B], SCREEN_A, MIN);
  expect(other.x === 1440, "B 와 344px 겹쳐서 B 안으로 " + JSON.stringify(other));
  return "ok";
});

test("fitChatBounds: 메뉴 막대 아래(y)와 화면 아래로 넘친 자리도 안으로", () => {
  const above = fitChatBounds({ x: 100, y: -300, width: 484, height: 624 }, [SCREEN_A], SCREEN_A, MIN);
  expect(above.y === SCREEN_A.y, "위로 넘침");
  const below = fitChatBounds({ x: 100, y: 800, width: 484, height: 624 }, [SCREEN_A], SCREEN_A, MIN);
  expect(below.y === SCREEN_A.y + SCREEN_A.height - 624, "아래로 넘침");
  return "ok";
});

test("growFromBar: 막대 윗변 가운데에서 아래로 자란다", () => {
  const bar = { x: 400, y: 200, width: 744, height: 94 };
  const chat = growFromBar(bar, { width: 484, height: 624 }, SCREEN_A);
  expect(chat.y === 200 && chat.x === 400 + 372 - 242 && chat.width === 484 && chat.height === 624, JSON.stringify(chat));
  const low = growFromBar({ x: 400, y: 700, width: 744, height: 94 }, { width: 484, height: 624 }, SCREEN_A);
  expect(low.y === SCREEN_A.y + SCREEN_A.height - 624, "아래가 넘으면 위로 당김");
  return "ok";
});

test("barFromChat: 대화 윗변 가운데에 막대를 맞춘다", () => {
  const chat = { x: 200, y: 150, width: 484, height: 624 };
  const bar = barFromChat(chat, { width: 744, height: 94 }, SCREEN_A);
  expect(bar.y === 150 && bar.x === 200 + 242 - 372, JSON.stringify(bar));
  const edge = barFromChat({ x: 0, y: 150, width: 484, height: 624 }, { width: 744, height: 94 }, SCREEN_A);
  expect(edge.x === 0, "왼쪽 끝이면 안으로");
  return "ok";
});

test("sameRect", () => {
  expect(sameRect({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }) && !sameRect(null, null) && !sameRect({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 5 }), "비교");
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
