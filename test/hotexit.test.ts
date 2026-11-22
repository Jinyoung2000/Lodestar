import { clearHotExit, collectHotExit, HOT_EXIT_KEY, loadHotExit, parseHotExit, planHotRestore, registerHotReader, saveHotExitNow, serializeHotExit, setHotAliveProvider, setPendingHot, takeHotRestore, takeHotSkipped, type HotDoc, type HotExit } from "../web/windowState";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function fakeEditor(key: string, saved: string, mtime: number | null) {
  const state = { current: saved };
  const off = registerHotReader(key, () => (state.current === saved ? null : { text: state.current, baseMtimeMs: mtime }));
  return { state, off };
}

let alive = new Set<string>();
setHotAliveProvider(() => alive);

{
  alive = new Set(["file:a", "file:b", "untitled:1"]);
  const a = fakeEditor("file:a", "one", 111);
  const b = fakeEditor("file:b", "two", 222);
  const u = fakeEditor("untitled:1", "", null);
  a.state.current = "one!";
  u.state.current = "scratch notes";
  const got = collectHotExit(alive);
  check("only dirty tabs are collected", Object.keys(got.docs).sort().join() === "file:a,untitled:1", Object.keys(got.docs).join());
  check("a file tab keeps the disk mtime it was based on", got.docs["file:a"].baseMtimeMs === 111 && got.docs["file:a"].text === "one!");
  check("an untitled tab has no mtime", got.docs["untitled:1"].baseMtimeMs === null);
  b.state.current = "two?";
  check("a tab becomes collected when it turns dirty", "file:b" in collectHotExit(alive).docs);
  b.state.current = "two";
  check("and drops out once it is clean again (saved or reverted)", !("file:b" in collectHotExit(alive).docs));
  alive = new Set(["file:a"]);
  check("tabs that are no longer open are not collected", Object.keys(collectHotExit(alive).docs).join() === "file:a");
  a.off();
  b.off();
  u.off();
}

{
  const storage = memoryStorage();
  alive = new Set(["file:a", "untitled:2"]);
  const a = fakeEditor("file:a", "const x = 1;\n", 5000);
  const u = fakeEditor("untitled:2", "", null);
  a.state.current = "const x = 2;\nconst y = 3;\n";
  u.state.current = "한글 메모\n두 번째 줄";
  saveHotExitNow(storage);
  const raw = storage.map.get(HOT_EXIT_KEY);
  check("save writes one record", typeof raw === "string" && raw.length > 0);
  a.off();
  u.off();

  const restored = loadHotExit(storage);
  check("a restart reads the same two documents back", restored.docs["file:a"]?.text === "const x = 2;\nconst y = 3;\n" && restored.docs["untitled:2"]?.text === "한글 메모\n두 번째 줄", JSON.stringify(restored.docs));
  setPendingHot(restored);
  alive = new Set(["file:a", "untitled:2"]);
  saveHotExitNow(storage);
  check("content waiting for its editor survives another save", loadHotExit(storage).docs["file:a"]?.text === "const x = 2;\nconst y = 3;\n");
  const hot = takeHotRestore("file:a");
  check("the editor takes the document once", hot?.text === "const x = 2;\nconst y = 3;\n" && takeHotRestore("file:a") === null);
  check("a taken document is not kept pending for later saves", !("file:a" in collectHotExit(alive).docs));
  saveHotExitNow(storage);
  const after = loadHotExit(storage);
  check("after being taken, only the document still waiting is stored", Object.keys(after.docs).join() === "untitled:2", Object.keys(after.docs).join());
  clearHotExit(storage);
  check("the pending untitled content is cleared too", takeHotRestore("untitled:2") === null);
}

{
  const storage = memoryStorage();
  alive = new Set(["file:c"]);
  const c = fakeEditor("file:c", "x", 1);
  c.state.current = "xy";
  saveHotExitNow(storage);
  check("dirty: stored", storage.map.has(HOT_EXIT_KEY));
  c.off();
  const c2 = fakeEditor("file:c", "xy", 2);
  saveHotExitNow(storage);
  check("after the tab is saved, the stored record is removed", !storage.map.has(HOT_EXIT_KEY));
  c2.off();
}

{
  alive = new Set(["file:big1", "file:big2", "file:small"]);
  const big1 = fakeEditor("file:big1", "", 1);
  const big2 = fakeEditor("file:big2", "", 2);
  const small = fakeEditor("file:small", "", 3);
  big1.state.current = "a".repeat(60);
  big2.state.current = "b".repeat(60);
  small.state.current = "c".repeat(10);
  const got = collectHotExit(alive, 100);
  check("docs are taken in tab order until the budget is spent", Object.keys(got.docs).join() === "file:big1,file:small", Object.keys(got.docs).join());
  check("the doc that did not fit is reported as skipped", got.skipped.join() === "file:big2");
  const storage = memoryStorage();
  const raw = serializeHotExit(got)!;
  storage.setItem(HOT_EXIT_KEY, raw);
  setPendingHot(loadHotExit(storage));
  check("the next launch is told about the skipped tab once", takeHotSkipped("file:big2") === true && takeHotSkipped("file:big2") === false);
  big1.off();
  big2.off();
  small.off();
  clearHotExit(storage);
}

{
  const empty: HotExit = { docs: {}, skipped: [] };
  check("null → empty", JSON.stringify(parseHotExit(null)) === JSON.stringify(empty));
  check("not json → empty", JSON.stringify(parseHotExit("{oops")) === JSON.stringify(empty));
  check("unknown version → empty", JSON.stringify(parseHotExit(JSON.stringify({ version: 99, docs: { a: { text: "x", baseMtimeMs: 1 } } }))) === JSON.stringify(empty));
  const mixed = parseHotExit(JSON.stringify({ version: 1, docs: { good: { text: "ok", baseMtimeMs: null }, badText: { text: 5, baseMtimeMs: 1 }, badMtime: { text: "x", baseMtimeMs: "1" }, nul: null }, skipped: ["k", 3] }));
  check("bad entries are dropped, good ones kept", Object.keys(mixed.docs).join() === "good" && mixed.skipped.join() === "k", JSON.stringify(mixed));
  check("nothing to keep serialises to null (the key is removed)", serializeHotExit(empty) === null);
}

{
  const hot: HotDoc = { text: "mine", baseMtimeMs: 1000 };
  check("same disk mtime: no conflict", planHotRestore(1000, hot).externalChange === false);
  check("disk changed since: conflict banner instead of a silent overwrite", planHotRestore(2000, hot).externalChange === true);
  check("untitled (no mtime on either side): no conflict", planHotRestore(null, { text: "n", baseMtimeMs: null }).externalChange === false);
}

{
  const storage = memoryStorage();
  alive = new Set(["file:d"]);
  const d = fakeEditor("file:d", "1", 1);
  d.state.current = "2";
  saveHotExitNow(storage);
  check("kept before the discard", storage.map.has(HOT_EXIT_KEY));
  clearHotExit(storage);
  check("discard removes the stored record", !storage.map.has(HOT_EXIT_KEY));
  d.off();
}

{
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("blocked"); } };
  alive = new Set(["file:e"]);
  const e = fakeEditor("file:e", "1", 1);
  e.state.current = "2";
  let threw = false;
  try {
    saveHotExitNow(broken);
    clearHotExit(broken);
    loadHotExit(broken);
  } catch {
    threw = true;
  }
  check("blocked or full storage never throws", !threw);
  e.off();
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
process.exit(0);
