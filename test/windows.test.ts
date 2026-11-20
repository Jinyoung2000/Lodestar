// 여러 창의 순수 로직 단독 시험(shared/windows.ts): 창 id, 저장소 범위, 옛 저장본 가져오기, registry, 닫기 정책, 명령 대상 창. 실행: npm test
import { addNewWindow, applyClose, cascade, closePolicy, EMPTY_REGISTRY, fitBounds, launchPlan, migrateLegacyStorage, newWindowPlan, parseRegistry, quitWhenAllWindowsClosed, scopedStorage, scopeOwner, serializeRegistry, staleScopeNames, sweepStaleScopes, targetWindow, updateRecord, windowForAgent, windowIdFromSearch, windowUrl, type KeyValueStorage, type Registry } from "../shared/windows";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const storage: KeyValueStorage & { map: Map<string, string> } = {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  return storage;
}

// 창 id
check("windowIdFromSearch: ?window=w2 만 받는다", windowIdFromSearch("?window=w2") === "w2" && windowIdFromSearch("?view=quick&window=w10") === "w10");
check("windowIdFromSearch: 없거나 모양이 틀리면 null", windowIdFromSearch("") === null && windowIdFromSearch("?window=main") === null && windowIdFromSearch("?window=w0") === null && windowIdFromSearch("?window=w2:x") === null);
check("windowUrl", windowUrl("http://127.0.0.1:7788", "w3") === "http://127.0.0.1:7788/?window=w3");

// 저장소 범위
{
  const base = memoryStorage({ "agent-nav:settings": "shared" });
  const a = scopedStorage(base, "w1");
  const b = scopedStorage(base, "w2");
  a.setItem("agent-nav:window-state", "A");
  b.setItem("agent-nav:window-state", "B");
  a.setItem("agent-nav:draft:new:pane-1", "draft A");
  b.setItem("agent-nav:draft:new:pane-1", "draft B");
  check("창마다 같은 이름을 따로 쓴다", a.getItem("agent-nav:window-state") === "A" && b.getItem("agent-nav:window-state") === "B");
  check("범위 밖(공유 설정)은 범위 안에서 안 보인다", a.getItem("agent-nav:settings") === null && base.getItem("agent-nav:settings") === "shared");
  check("length 와 key 는 자기 범위만 센다", a.length === 2 && b.length === 2 && a.key(0) !== null && !a.key(0)!.startsWith("agent-nav:w:") && a.key(2) === null);
  // 한 창이 접두 순회로 지워도 다른 창은 그대로(dropStoredDraftsOfMissingPanes 와 같은 순회)
  for (let i = a.length - 1; i >= 0; i--) {
    const name = a.key(i);
    if (name?.startsWith("agent-nav:draft:")) a.removeItem(name);
  }
  check("접두 순회로 지워도 다른 창의 초안은 남는다", b.getItem("agent-nav:draft:new:pane-1") === "draft B" && a.getItem("agent-nav:draft:new:pane-1") === null);
  check("scopeOwner", scopeOwner("agent-nav:w:w2:agent-nav:draft:x") === "w2" && scopeOwner("agent-nav:draft:x") === null && scopeOwner("agent-nav:w:bad:x") === null);
}

// 닫힌 창의 범위 정리
{
  const base = memoryStorage({ "agent-nav:w:w1:agent-nav:window-state": "1", "agent-nav:w:w2:agent-nav:window-state": "2", "agent-nav:w:w2:agent-nav:hot-exit": "h", "agent-nav:w:w3:agent-nav:draft:x": "d", "agent-nav:settings": "s" });
  const stale = staleScopeNames([...base.map.keys()], new Set(["w1", "w3"]));
  check("살아 있는 창 목록에 없는 창의 이름만 정리 대상", stale.length === 2 && stale.every((n) => n.startsWith("agent-nav:w:w2:")));
  const removed = sweepStaleScopes(base, new Set(["w1", "w3"]));
  check("sweep 은 w2 범위만 지운다", removed === 2 && base.map.size === 3 && base.getItem("agent-nav:settings") === "s" && base.getItem("agent-nav:w:w3:agent-nav:draft:x") === "d");
}

// 옛 단일 창 저장본
{
  const base = memoryStorage({ "agent-nav:window-state": "S", "agent-nav:hot-exit": "H", "agent-nav:draft:abc": "d1", "agent-nav:draft:new:pane-1": "d2", "agent-nav:layout": "L" });
  check("w2 는 옛 저장본을 가져가지 않는다", migrateLegacyStorage(base, "w2") === 0 && base.getItem("agent-nav:window-state") === "S");
  const moved = migrateLegacyStorage(base, "w1");
  const w1 = scopedStorage(base, "w1");
  check("w1 이 window-state, hot-exit, 초안을 자기 범위로 옮긴다", moved === 4 && w1.getItem("agent-nav:window-state") === "S" && w1.getItem("agent-nav:hot-exit") === "H" && w1.getItem("agent-nav:draft:abc") === "d1" && w1.getItem("agent-nav:draft:new:pane-1") === "d2");
  check("옛 이름은 지우고 공유 설정(layout)은 건드리지 않는다", base.getItem("agent-nav:window-state") === null && base.getItem("agent-nav:draft:abc") === null && base.getItem("agent-nav:layout") === "L");
  check("범위가 이미 있으면 다시 가져오지 않는다", (base.setItem("agent-nav:window-state", "S2"), migrateLegacyStorage(base, "w1") === 0 && base.getItem("agent-nav:window-state") === "S2"));
}

// registry
{
  check("parseRegistry: 깨진 글, 모르는 버전은 빈 목록", parseRegistry(null) === EMPTY_REGISTRY && parseRegistry("{") === EMPTY_REGISTRY && parseRegistry(JSON.stringify({ version: 9, windows: [] })) === EMPTY_REGISTRY);
  const raw = JSON.stringify({ version: 1, seq: 1, windows: [{ id: "w2", bounds: { x: 10.4, y: 20, width: 800, height: 600 }, maximized: true }, { id: "w2" }, { id: "bad" }, { id: "w5", bounds: { x: 0, y: 0, width: 0, height: 5 } }] });
  const reg = parseRegistry(raw);
  check("parseRegistry: 중복과 잘못된 id 를 거르고 모양을 다듬는다", reg.windows.map((w) => w.id).join() === "w2,w5" && reg.windows[0].bounds?.x === 10 && reg.windows[0].maximized && reg.windows[1].bounds === null);
  check("parseRegistry: seq 는 가장 큰 id 이상", reg.seq === 5);
  check("직렬화 왕복", JSON.stringify(parseRegistry(serializeRegistry(reg))) === JSON.stringify(reg));
}

// 실행할 때 열 창
{
  const first = launchPlan(EMPTY_REGISTRY);
  check("저장본이 없으면 w1 하나", first.open.length === 1 && first.open[0].id === "w1" && first.registry.seq === 1 && first.registry.windows.length === 1);
  const two: Registry = { version: 1, seq: 4, windows: [{ id: "w2", bounds: { x: 1, y: 2, width: 3, height: 4 }, maximized: false, fullScreen: false }, { id: "w4", bounds: null, maximized: false, fullScreen: true }] };
  const plan = launchPlan(two);
  check("저장본의 창을 모두, 순서와 자리 그대로 연다", plan.open.map((w) => w.id).join() === "w2,w4" && plan.open[0].bounds?.width === 3 && plan.open[1].fullScreen && plan.registry === two);
}

// 새 창 요청
{
  const one: Registry = { version: 1, seq: 3, windows: [{ id: "w3", bounds: { x: 5, y: 5, width: 900, height: 700 }, maximized: false, fullScreen: false }] };
  const reopened = newWindowPlan(one, new Set(), null);
  check("열린 창이 없으면 목록에 남은 마지막 창을 되살린다", reopened.reused && reopened.record.id === "w3" && reopened.registry === one);
  const added = newWindowPlan(one, new Set(["w3"]), { x: 35, y: 35, width: 900, height: 700 });
  check("열린 창이 있으면 새 id 의 빈 창(목록에 더해진다)", !added.reused && added.record.id === "w4" && added.registry.windows.length === 2 && added.registry.seq === 4 && added.record.bounds?.x === 35);
  const none = newWindowPlan(EMPTY_REGISTRY, new Set(), null);
  check("목록도 비었으면 w1", none.record.id === "w1" && !none.reused);
  check("addNewWindow 는 id 를 다시 쓰지 않는다", addNewWindow(applyClose({ ...one, seq: 7 }, "w3", "remove")).record.id === "w8");
}

// 닫기 정책
{
  check("종료 중에 닫히는 창은 목록에 남긴다(다음 실행이 되살린다)", closePolicy({ quitting: true, registryCount: 3 }) === "keep");
  check("창이 여럿일 때 하나를 닫으면 목록에서 뺀다", closePolicy({ quitting: false, registryCount: 2 }) === "remove");
  check("마지막 창은 남긴다(다음 실행 기본값)", closePolicy({ quitting: false, registryCount: 1 }) === "keep" && closePolicy({ quitting: false, registryCount: 0 }) === "keep");
  const reg: Registry = { version: 1, seq: 2, windows: [{ id: "w1", bounds: null, maximized: false, fullScreen: false }, { id: "w2", bounds: null, maximized: false, fullScreen: false }] };
  check("applyClose", applyClose(reg, "w1", "remove").windows.map((w) => w.id).join() === "w2" && applyClose(reg, "w1", "keep") === reg);
  check("updateRecord 는 없는 id 를 무시하고 있으면 고친다", updateRecord(reg, "w9", { maximized: true }) === reg && updateRecord(reg, "w2", { maximized: true }).windows[1].maximized);
  check("마지막 창을 닫아도 macOS 는 앱을 끝내지 않는다", !quitWhenAllWindowsClosed("darwin") && quitWhenAllWindowsClosed("linux") && quitWhenAllWindowsClosed("win32"));
}

// 명령 대상 창
{
  const ids = ["w1", "w2", "w3"];
  check("OS 포커스가 있으면 그 창", targetWindow({ ids, focusedId: "w2", lastActiveId: "w1" }) === "w2");
  check("포커스가 없으면 마지막 활성 창(시험 인스턴스)", targetWindow({ ids, focusedId: null, lastActiveId: "w1" }) === "w1");
  check("마지막 활성 창도 사라졌으면 가장 나중에 만든 창", targetWindow({ ids, focusedId: null, lastActiveId: "w9" }) === "w3");
  check("창이 없으면 null", targetWindow({ ids: [], focusedId: null, lastActiveId: null }) === null);
  const windows = [
    { id: "w1", agentIds: new Set(["a"]) },
    { id: "w2", agentIds: new Set(["b"]) },
    { id: "w3", agentIds: new Set(["a", "b"]) },
  ];
  check("알림: 그 세션이 열린 창으로(w2 는 안 열려 있다)", windowForAgent({ windows, agentId: "a", focusedId: null, lastActiveId: null }) === "w3");
  check("알림: 열린 창이 여럿이면 포커스, 마지막 활성 순", windowForAgent({ windows, agentId: "a", focusedId: "w1", lastActiveId: "w3" }) === "w1" && windowForAgent({ windows, agentId: "a", focusedId: null, lastActiveId: "w1" }) === "w1");
  check("알림: 어느 창에도 안 열려 있으면 명령 대상 창", windowForAgent({ windows, agentId: "zzz", focusedId: null, lastActiveId: "w2" }) === "w2");
}

// 창 자리
{
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  check("fitBounds: 화면 안이면 그대로", JSON.stringify(fitBounds({ x: 100, y: 100, width: 800, height: 600 }, [area])) === JSON.stringify({ x: 100, y: 100, width: 800, height: 600 }));
  check("fitBounds: 빠진 화면에 있던 창은 null(가운데에 둔다)", fitBounds({ x: 3000, y: 100, width: 800, height: 600 }, [area]) === null);
  check("fitBounds: 모서리만 걸친 창도 null", fitBounds({ x: 1900, y: 1060, width: 800, height: 600 }, [area]) === null && fitBounds(null, [area]) === null);
  const next = cascade({ x: 100, y: 100, width: 1440, height: 900 }, area);
  check("cascade: 오른쪽 아래로 30px", next?.x === 130 && next?.y === 130 && next?.width === 1440);
  const wrapped = cascade({ x: 600, y: 200, width: 1440, height: 900 }, area);
  check("cascade: 화면 밖으로 나가면 왼쪽 위에서 다시", wrapped?.x === 30 && wrapped?.y === 30);
  check("cascade: 기준이 없으면 null", cascade(null, area) === null);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
process.exit(0);
