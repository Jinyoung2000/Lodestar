import { categoriesFor, isAlwaysAllowed, PERMISSION_CATEGORIES, PERMISSION_DEFAULTS, PermissionStore, permissionOrigin } from "../web/browserPermissions";
import { S } from "../web/strings";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("범주와 기본값: 순서는 VS Code 와 같고 sensors 와 devices 만 기본 허용", () => {
  expect(PERMISSION_CATEGORIES.join() === "location,camera,microphone,sensors,clipboard,notifications,devices", PERMISSION_CATEGORIES.join());
  expect(PERMISSION_CATEGORIES.filter((c) => PERMISSION_DEFAULTS[c] === "allow").join() === "sensors,devices", "기본 허용");
  expect(S.browserPermissions.map((p) => p.category).join() === PERMISSION_CATEGORIES.join() && S.browserPermissions[0].detail === "Access this device's geographic location", "화면 문구가 같은 순서");
  return "ok";
});

test("Electron 권한 이름의 범주: media 는 종류별, 모르는 권한은 빈 목록, 늘 허용하는 넷", () => {
  expect(categoriesFor("geolocation").join() === "location" && categoriesFor("geolocation-approximate").join() === "location", "위치");
  expect(categoriesFor("media", ["video"]).join() === "camera" && categoriesFor("media", ["audio"]).join() === "microphone" && categoriesFor("media", ["video", "audio"]).join() === "camera,microphone", "media");
  expect(categoriesFor("media").join() === "camera,microphone", "종류를 모르면 둘 다");
  expect(categoriesFor("usb").join() === "devices" && categoriesFor("clipboard-read").join() === "clipboard" && categoriesFor("notifications").join() === "notifications" && categoriesFor("sensors").join() === "sensors", "나머지");
  expect(categoriesFor("midi").length === 0 && categoriesFor("openExternal").length === 0, "모르는 권한");
  for (const name of ["pointerLock", "keyboardLock", "fullscreen", "clipboard-sanitized-write"]) expect(isAlwaysAllowed(name), name);
  expect(!isAlwaysAllowed("geolocation"), "위치는 묻는다");
  return "ok";
});

test("판정: 기록이 있으면 그것, 없으면 기본값. ask 는 묻고 deny 는 묻지 않는다", () => {
  const store = new PermissionStore();
  const origin = "http://localhost:7801";
  expect(store.decide(origin, ["location"]) === "ask" && store.decide(origin, ["sensors"]) === "allow" && store.decide(origin, ["devices"]) === "allow", "기본");
  store.set(origin, "location", "allow");
  expect(store.decide(origin, ["location"]) === "allow" && store.decide("http://other.test", ["location"]) === "ask", "사이트별 허용");
  store.set(origin, "location", "deny");
  expect(store.decide(origin, ["location"]) === "deny", "차단");
  store.set(origin, "sensors", "deny");
  expect(store.decide(origin, ["sensors"]) === "deny", "기본 허용도 차단할 수 있다");
  store.set(origin, "sensors", null);
  expect(store.decide(origin, ["sensors"]) === "allow" && store.stateOf(origin, "sensors") === "allow", "기록을 지우면 기본값");
  store.set(origin, "camera", "allow");
  expect(store.decide(origin, ["camera", "microphone"]) === "ask", "하나만 허용이면 나머지를 묻는다");
  store.set(origin, "microphone", "deny");
  expect(store.decide(origin, ["camera", "microphone"]) === "deny", "하나라도 차단이면 거절");
  expect(store.decide("", ["location"]) === "deny" && store.decide(origin, []) === "deny", "origin 이 없거나 모르는 권한은 거절");
  return "ok";
});

test("저장: 직렬화하고 되살릴 때 모르는 범주와 값은 버린다", () => {
  const store = new PermissionStore();
  store.set("http://a.test", "camera", "allow");
  store.set("http://a.test", "notifications", "deny");
  const copy = new PermissionStore();
  copy.hydrate(JSON.parse(JSON.stringify(store.serialize())));
  expect(copy.getDecision("http://a.test", "camera") === "allow" && copy.getDecision("http://a.test", "notifications") === "deny", "되살림");
  copy.hydrate({ "http://b.test": { camera: "allow", fridge: "allow", microphone: "maybe" }, "": { camera: "allow" }, bad: 5 });
  expect(Object.keys(copy.serialize()).join() === "http://b.test" && copy.getDecision("http://b.test", "camera") === "allow" && copy.getDecision("http://b.test", "microphone") === undefined, JSON.stringify(copy.serialize()));
  copy.hydrate(null);
  expect(Object.keys(copy.serialize()).length === 0, "비움");
  return "ok";
});

test("origin: http 와 https 만, 포트까지 구분", () => {
  expect(permissionOrigin("http://localhost:7801/two.html?q=1") === "http://localhost:7801" && permissionOrigin("https://a.test/x") === "https://a.test", "origin");
  expect(permissionOrigin("file:///tmp/a.html") === "" && permissionOrigin("not a url") === "" && permissionOrigin("") === "", "그 밖은 빈 글");
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
