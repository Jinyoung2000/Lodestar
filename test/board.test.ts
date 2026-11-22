import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-board-unit-"));
process.env.AGENT_NAV_HOME = home;
const { BoardStore } = await import("../server/board");

const fresh = () => {
  rmSync(join(home, "board.json"), { force: true });
  return new BoardStore();
};

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const throws = (fn: () => unknown, pattern: RegExp) => {
  try {
    fn();
  } catch (error) {
    return expect(pattern.test((error as Error).message), (error as Error).message);
  }
  throw new Error("did not throw");
};
const titles = (store: InstanceType<typeof BoardStore>, columnId: string) => store.get().cards.filter((c) => c.columnId === columnId).map((c) => c.title).join("|");

test("A new board has the five default columns with roles", () => {
  const store = fresh();
  return expect(store.get().columns.map((c) => `${c.name}:${c.role}`).join() === "Backlog:backlog,Todo:todo,In Progress:inProgress,Review:review,Done:done", "defaults");
});

test("Writes go through a temp file and leave no .tmp behind; a new store reads the same board", () => {
  const store = fresh();
  const card = store.createCard({ title: "  keep   me  ", body: "# hi", labels: ["a", "A", "b"], links: [{ url: "https://example.com/x", title: null }] });
  expect(card.title === "keep me", "title is trimmed and collapsed");
  expect(card.labels.join() === "a,b", "labels are de-duplicated ignoring case");
  expect(!readdirSync(home).some((f) => f.endsWith(".tmp")), "no temp file left");
  const reread = new BoardStore();
  return expect(JSON.stringify(reread.get()) === JSON.stringify(store.get()), "same after reload");
});

test("moveCard keeps the order and only stamps updatedAt when the column changes", () => {
  const store = fresh();
  const a = store.createCard({ title: "a", columnId: "todo" });
  const b = store.createCard({ title: "b", columnId: "todo" });
  const c = store.createCard({ title: "c", columnId: "todo" });
  const stamp = store.card(b.id).updatedAt;
  store.moveCard(c.id, "todo", 0);
  expect(titles(store, "todo").endsWith("c|a|b"), titles(store, "todo"));
  expect(store.card(c.id).updatedAt === c.updatedAt, "same column: not stamped");
  store.moveCard(a.id, "review", 99);
  expect(store.card(a.id).columnId === "review", "moved");
  expect(store.card(b.id).updatedAt === stamp, "others untouched");
  return "ok";
});

test("moveCard rejects a fractional index", () => {
  const store = fresh();
  const card = store.createCard({ title: "z" });
  return throws(() => store.moveCard(card.id, "todo", 0.5), /whole number/);
});

test("Deleting a column moves its cards to the end of the previous column; the first column hands over to the next", () => {
  const store = fresh();
  const x = store.createCard({ title: "x", columnId: "review" });
  store.createCard({ title: "y", columnId: "done" });
  store.deleteColumn("review");
  expect(store.card(x.id).columnId === "inProgress", "went to In Progress");
  store.deleteColumn("backlog");
  return expect(store.get().columns[0].id === "todo", "todo is first now");
});

test("The last column cannot be deleted", () => {
  const store = fresh();
  for (const column of [...store.get().columns].slice(1)) store.deleteColumn(column.id);
  return throws(() => store.deleteColumn(store.get().columns[0].id), /last column/);
});

test("Auto-move: only cards in the source roles move, Done is never touched, a missing target column does nothing", () => {
  const store = fresh();
  const todo = store.createCard({ title: "todo", columnId: "todo" });
  const done = store.createCard({ title: "done", columnId: "done" });
  const review = store.createCard({ title: "review", columnId: "review" });
  expect(store.moveToRole([todo.id, done.id, review.id], ["backlog", "todo"], "inProgress") === true, "changed");
  expect(store.card(todo.id).columnId === "inProgress", "todo moved");
  expect(store.card(done.id).columnId === "done" && store.card(review.id).columnId === "review", "others stay");
  expect(store.moveToRole([todo.id], ["inProgress"], "review") && store.card(todo.id).columnId === "review", "in progress to review");
  store.deleteColumn("review");
  const again = store.createCard({ title: "again", columnId: "inProgress" });
  expect(store.moveToRole([again.id], ["inProgress"], "review") === false && store.card(again.id).columnId === "inProgress", "no Review column, no move");
  return "ok";
});

test("Renaming a column does not change its role, so the auto-move rule keeps working", () => {
  const store = fresh();
  store.renameColumn("inProgress", "Doing");
  const card = store.createCard({ title: "q", columnId: "todo" });
  store.moveToRole([card.id], ["backlog", "todo"], "inProgress");
  return expect(store.column(store.card(card.id).columnId).name === "Doing", "moved into the renamed column");
});

test("prune drops deleted sessions and workspaces from cards", () => {
  const store = fresh();
  const card = store.createCard({ title: "p", workspaceId: "w1", agentIds: ["a1", "a2"] });
  store.prune(new Set(["a2"]), new Set());
  return expect(store.card(card.id).agentIds.join() === "a2" && store.card(card.id).workspaceId === null, "pruned");
});

test("TOBOARD: a card keeps its conversation source across a reload", () => {
  const store = fresh();
  const card = store.createCard({ title: "from chat", agentIds: ["a1"], source: { agentId: "a1", itemId: "m1", part: "some words" } });
  const reread = new BoardStore().card(card.id);
  return expect(reread.source?.agentId === "a1" && reread.source.itemId === "m1" && reread.source.part === "some words", "source survived sanitizeBoard");
});

test("TOBOARD: a malformed source is rejected on create and dropped on load", () => {
  const store = fresh();
  throws(() => store.createCard({ title: "x", source: { agentId: "", itemId: "m", part: null } }), /source/);
  throws(() => store.createCard({ title: "x", source: { agentId: "a", itemId: "m", part: "p".repeat(401) } }), /source/);
  const card = store.createCard({ title: "ok" });
  expect(card.source === undefined, "no source leaves the field out");
  writeFileSync(join(home, "board.json"), JSON.stringify({ columns: store.get().columns, cards: [{ ...card, source: { agentId: 1 } }] }));
  const loaded = new BoardStore().card(card.id);
  return expect(loaded.source === undefined && loaded.title === "ok", "bad source dropped, card kept");
});

test("TOBOARD: auto-move skips cards made from the linked session itself", () => {
  const store = fresh();
  const fromChat = store.createCard({ title: "chat", agentIds: ["a1"], source: { agentId: "a1", itemId: "m1", part: null } });
  const tracked = store.createCard({ title: "tracked", agentIds: ["a1"] });
  const other = store.createCard({ title: "other session", agentIds: ["a2"], source: { agentId: "a2", itemId: "m1", part: null } });
  store.linkAgent(other.id, "a1");
  const ids = store.cardsLinkedTo("a1").map((c) => c.id);
  return expect(!ids.includes(fromChat.id) && ids.includes(tracked.id) && ids.includes(other.id), "own-source card exempt, others tracked");
});

test("A corrupt board.json is moved aside, not overwritten", () => {
  writeFileSync(join(home, "board.json"), "{ not json");
  const store = new BoardStore();
  expect(store.get().cards.length === 0, "fresh board");
  const aside = readdirSync(home).find((f) => f.startsWith("board.json.corrupt-"));
  expect(!!aside && readFileSync(join(home, aside!), "utf8") === "{ not json", "original kept");
  return expect(!existsSync(join(home, "board.json")), "nothing written until the first change");
});

const { sortCards, labelColorOf, LABEL_COLORS, cardKey, numberCards } = await import("../shared/board");

test("BOARDUX: a new card gets priority 0 and the next number; numbers are never reused after a delete and survive a reload", () => {
  const store = fresh();
  const a = store.createCard({ title: "a" });
  const b = store.createCard({ title: "b", priority: 2 });
  expect(a.priority === 0 && b.priority === 2, "priority default and explicit");
  expect(a.number === 1 && b.number === 2 && store.get().nextNumber === 3, "numbers 1, 2, next 3");
  store.deleteCard(b.id);
  const c = store.createCard({ title: "c" });
  expect(c.number === 3, "deleted number 2 is not handed out again");
  const reread = new BoardStore();
  expect(reread.get().nextNumber === 4 && reread.card(c.id).number === 3, "same after reload");
  return expect(cardKey(c) === "LOD-3", cardKey(c));
});

test("BOARDUX: priority is validated on create and update (0..4 whole numbers only)", () => {
  const store = fresh();
  const card = store.createCard({ title: "p" });
  for (const bad of [5, -1, 1.5, "2", null, NaN]) {
    throws(() => store.updateCard(card.id, { priority: bad as never }), /priority/);
    throws(() => store.createCard({ title: "x", priority: bad as never }), /priority/);
  }
  expect(store.updateCard(card.id, { priority: 1 }).priority === 1, "set 1");
  expect(store.updateCard(card.id, { priority: 0 }).priority === 0, "back to 0");
  expect(store.get().cards.length === 1, "failed creates left no card");
  return expect(store.get().nextNumber === 2, "failed creates did not burn a number");
});

test("BOARDUX: number cannot be set through create or update", () => {
  const store = fresh();
  const card = store.createCard({ title: "n", number: 99 } as never);
  expect(card.number === 1, "create ignores number");
  store.updateCard(card.id, { number: 50 } as never);
  return expect(store.card(card.id).number === 1, "update ignores number");
});

test("BOARDUX: an old board.json without priority and number still loads; numbers follow createdAt, are saved, and stay the same on the next read", () => {
  const legacy = {
    columns: [
      { id: "todo", name: "Todo", role: "todo" },
      { id: "done", name: "Done", role: "done" },
    ],
    cards: [
      { id: "newest", columnId: "todo", title: "newest", body: "", labels: ["UI"], workspaceId: null, agentIds: [], links: [], createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" },
      { id: "oldest", columnId: "done", title: "oldest", body: "", labels: [], workspaceId: null, agentIds: [], links: [], createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: "middle", columnId: "todo", title: "middle", body: "", labels: [], workspaceId: "w1", agentIds: ["a1"], links: [], createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" },
    ],
  };
  writeFileSync(join(home, "board.json"), JSON.stringify(legacy));
  const store = new BoardStore();
  const byId = (id: string) => store.card(id);
  expect(byId("oldest").number === 1 && byId("middle").number === 2 && byId("newest").number === 3, "numbered by createdAt");
  expect(store.get().cards.every((c) => c.priority === 0), "priority 0");
  expect(store.get().nextNumber === 4, "next number saved");
  expect(byId("middle").workspaceId === "w1" && byId("middle").agentIds.join() === "a1" && byId("newest").labels.join() === "UI", "old fields untouched");
  const onDisk = JSON.parse(readFileSync(join(home, "board.json"), "utf8"));
  expect(onDisk.nextNumber === 4 && onDisk.cards.every((c: { number: number }) => typeof c.number === "number"), "migration written to disk");
  const again = new BoardStore();
  expect(again.card("oldest").number === 1 && again.card("newest").number === 3, "stable on the next read");
  return expect(again.createCard({ title: "after" }).number === 4, "next card continues at 4");
});

test("BOARDUX: duplicate or invalid numbers in a hand-edited file are repaired without touching the earlier card", () => {
  const { numbers, next } = numberCards(
    [
      { id: "a", createdAt: "2026-10-01T00:00:00.000Z", number: 7 },
      { id: "b", createdAt: "2026-10-02T00:00:00.000Z", number: 7 },
      { id: "c", createdAt: "2026-10-03T00:00:00.000Z", number: "x" },
    ],
    undefined,
  );
  expect(numbers.get("a") === 7, "first keeps 7");
  expect(numbers.get("b") === 8 && numbers.get("c") === 9 && next === 10, `repaired ${[...numbers.values()].join()}`);
  return "ok";
});

test("BOARDUX: sortCards by priority is stable and puts no-priority last; updated is newest first; manual keeps the order", () => {
  const c = (id: string, priority: 0 | 1 | 2 | 3 | 4, updatedAt: string) => ({ id, priority, updatedAt });
  const cards = [c("none-1", 0, "2026-10-05T00:00:00Z"), c("low", 4, "2026-10-01T00:00:00Z"), c("urgent", 1, "2026-10-02T00:00:00Z"), c("none-2", 0, "2026-10-09T00:00:00Z"), c("high-1", 2, "2026-10-03T00:00:00Z"), c("high-2", 2, "2026-10-07T00:00:00Z"), c("med", 3, "2026-10-04T00:00:00Z")];
  const ids = (list: { id: string }[]) => list.map((x) => x.id).join();
  expect(ids(sortCards(cards, "priority")) === "urgent,high-1,high-2,med,low,none-1,none-2", ids(sortCards(cards, "priority")));
  expect(ids(sortCards(cards, "updated")) === "none-2,high-2,none-1,med,high-1,urgent,low", ids(sortCards(cards, "updated")));
  expect(sortCards(cards, "manual") === cards, "manual returns the same array");
  expect(ids(cards) === "none-1,low,urgent,none-2,high-1,high-2,med", "input not mutated");
  return "ok";
});

test("BOARDUX: label color is deterministic, ignores case and spaces, stays inside the palette, and a user choice wins", () => {
  expect(labelColorOf({}, "Bug") === labelColorOf({}, "bug") && labelColorOf({}, "bug") === labelColorOf({}, "  BUG "), "case and spaces ignored");
  expect(labelColorOf({}, "slack") === labelColorOf({}, "slack"), "same on every call");
  const seen = new Set<number>();
  for (const label of ["slack", "bug", "ui", "docs", "backend", "research", "tests", "design", "infra", "한글 라벨"]) {
    const color = labelColorOf({}, label);
    expect(Number.isInteger(color) && color >= 0 && color < LABEL_COLORS, `${label} in range`);
    seen.add(color);
  }
  expect(seen.size >= 4, `spread over ${seen.size} colors`);
  expect(labelColorOf({ bug: 5 }, "BUG") === 5, "chosen color wins, key is lower case");
  return expect(labelColorOf({ bug: 99 }, "bug") === labelColorOf({}, "bug"), "out of range choice ignored");
});

test("BOARDUX: setLabelColor stores a lower-case key, null removes it, bad colors are rejected, and it survives a reload", () => {
  const store = fresh();
  store.setLabelColor("Bug", 3);
  expect(store.get().labelColors.bug === 3, "stored lower case");
  expect(new BoardStore().get().labelColors.bug === 3, "reloaded");
  throws(() => store.setLabelColor("bug", 8), /color/);
  throws(() => store.setLabelColor("bug", 1.5), /color/);
  throws(() => store.setLabelColor("  ", 1), /label/i);
  store.setLabelColor("bug", null);
  return expect(!("bug" in store.get().labelColors), "removed");
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
