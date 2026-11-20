// 사이드바 Notion 고정 목록의 데몬 저장소 시험. 임시 폴더에만 쓰고 Notion 에는 접속하지 않는다. 실행: npm test
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-notionpins-"));
process.env.AGENT_NAV_HOME = home;
const { NotionPinStore } = await import("../server/notionPins");

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (actual: unknown, wanted: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
  return JSON.stringify(actual);
};
const throws = (fn: () => unknown, part: string) => {
  try {
    fn();
  } catch (error) {
    if (!(error as Error).message.includes(part)) throw new Error(`threw "${(error as Error).message}", wanted "${part}"`);
    return (error as Error).message;
  }
  throw new Error("did not throw");
};

const A = "https://app.notion.com/p/0123456789abcdef0123456789abcdef";
const B = "https://app.notion.com/p/fedcba9876543210fedcba9876543210";
const C = "https://app.notion.com/p/00112233445566778899aabbccddeeff";
const file = join(home, "pins.json");
const fresh = () => new NotionPinStore(join(home, `p-${Math.random().toString(36).slice(2)}.json`));

test("add keeps order and the emoji icon, drops image-address icons", () => {
  const store = fresh();
  store.add({ title: "업무 요약", url: A, kind: "database" });
  store.add({ title: "개인", url: B, icon: "💻" });
  store.add({ title: "Trust&Safety", url: C, icon: "https://img.notion.so/x.png" });
  return expect(store.list().map((p) => [p.title, p.icon, p.kind]), [["업무 요약", null, "database"], ["개인", "💻", "page"], ["Trust&Safety", null, "page"]]);
});

test("adding the same page again returns the existing pin", () => {
  const store = fresh();
  const first = store.add({ title: "개인", url: B });
  const again = store.add({ title: "다른 이름", url: `https://www.notion.so/Whatever-fedcba9876543210fedcba9876543210?pvs=4` });
  return expect([again.added, again.pin.id === first.pin.id, store.list().length], [false, true, 1]);
});

test("add rejects non-notion links", () => {
  const store = fresh();
  throws(() => store.add({ title: "x", url: "https://example.com/a" }), "Notion");
  return expect(store.list().length, 0);
});

test("empty title falls back to the address guess, then to a generic name", () => {
  const store = fresh();
  const a = store.add({ title: "  ", url: "https://www.notion.so/Weekly-Report-0123456789abcdef0123456789abcdef" });
  const b = store.add({ title: "", url: B });
  return expect([a.pin.title, a.pin.titleSource, b.pin.title], ["Weekly Report", "url", "Notion page"]);
});

test("rename marks the title as user-chosen; empty name is refused", () => {
  const store = fresh();
  const { pin } = store.add({ title: "개인", url: B });
  const renamed = store.update(pin.id, { title: "  내 페이지  " });
  throws(() => store.update(pin.id, { title: "   " }), "empty");
  return expect([renamed.title, renamed.titleSource], ["내 페이지", "user"]);
});

test("title read from a tab is stored as page title", () => {
  const store = fresh();
  const { pin } = store.add({ title: "", url: A });
  const next = store.update(pin.id, { title: "업무 요약", titleSource: "page" });
  return expect([next.title, next.titleSource], ["업무 요약", "page"]);
});

test("move puts the pin at the index counted without itself", () => {
  const store = fresh();
  const a = store.add({ title: "a", url: A }).pin;
  const b = store.add({ title: "b", url: B }).pin;
  const c = store.add({ title: "c", url: C }).pin;
  store.move(c.id, 0);
  const first = store.list().map((p) => p.title).join("");
  store.move(c.id, 99);
  const second = store.list().map((p) => p.title).join("");
  store.move(a.id, 1);
  void b;
  return expect([first, second, store.list().map((p) => p.title).join("")], ["cab", "abc", "bac"]);
});

test("remove deletes, unknown id throws", () => {
  const store = fresh();
  const { pin } = store.add({ title: "a", url: A });
  store.remove(pin.id);
  throws(() => store.remove(pin.id), "no longer exists");
  return expect(store.list().length, 0);
});

test("pins survive a restart (new store on the same file)", () => {
  const path = join(home, "persist.json");
  const one = new NotionPinStore(path);
  one.add({ title: "개인", url: B, icon: "💻" });
  one.add({ title: "업무 요약", url: A, kind: "database" });
  const two = new NotionPinStore(path);
  return expect(two.list().map((p) => [p.title, p.icon, p.kind]), [["개인", "💻", "page"], ["업무 요약", null, "database"]]);
});

test("a hand-broken file is moved aside, not overwritten, and the list starts empty", () => {
  writeFileSync(file, "{ not json");
  const store = new NotionPinStore(file);
  const aside = readdirSync(home).filter((n) => n.startsWith("pins.json.corrupt-"));
  return expect([store.list().length, aside.length, existsSync(file)], [0, 1, false]);
});

test("bad entries in a valid file are dropped: wrong host, duplicates, no title", () => {
  const path = join(home, "dirty.json");
  writeFileSync(path, JSON.stringify([{ id: "1", title: "ok", url: A }, { id: "2", title: "dup", url: A }, { id: "3", title: "x", url: "https://example.com/" }, { id: "4", title: "", url: B }, { id: "5", title: "icon", url: C, icon: "abc" }]));
  const store = new NotionPinStore(path);
  return expect(store.list().map((p) => [p.id, p.icon]), [["1", null], ["5", null]]);
});

test("saved file is the pin array", () => {
  const path = join(home, "shape.json");
  const store = new NotionPinStore(path);
  store.add({ title: "개인", url: B, icon: "💻" });
  const saved = JSON.parse(readFileSync(path, "utf8"));
  return expect([Array.isArray(saved), saved[0].title, saved[0].icon, Object.keys(saved[0]).sort()], [true, "개인", "💻", ["icon", "id", "kind", "title", "titleSource", "url"]]);
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`PASS ${c.name}: ${c.run()}`.slice(0, 200));
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
