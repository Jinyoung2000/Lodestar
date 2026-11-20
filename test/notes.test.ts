// NoteStore 단독 시험 (데몬 없이). 저장, 목록 정렬, 삭제(휴지통), 동시 저장, 검색, 깨진 입력을 임시 폴더에서 확인한다.
// 실행: npm test
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteMatches, notePreviewOf, noteTitleOf } from "../shared/notes";
import { NoteStore } from "../server/notes";
import { paletteCommands } from "../web/commands";
import { BINDINGS } from "../web/keymap";

const root = mkdtempSync(join(tmpdir(), "agent-nav-notes-unit-"));
let n = 0;
const fresh = () => {
  const dir = join(root, `n${n++}`);
  return { dir, store: new NoteStore(dir) };
};

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
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
const files = (dir: string) => readdirSync(dir).sort();
const setMtime = (file: string, iso: string) => utimesSync(file, new Date(iso), new Date(iso));

test("Title is the first non-empty line without markdown lead; preview is the next lines", () => {
  expect(noteTitleOf("\n\n## Weekly plan\nbody") === "Weekly plan", noteTitleOf("\n\n## Weekly plan\nbody"));
  expect(noteTitleOf("- [ ] buy milk") === "buy milk", "task list lead");
  expect(noteTitleOf("   \n  ") === "", "blank text has no title");
  expect(notePreviewOf("Title\n\nfirst line\n> second line") === "first line second line", notePreviewOf("Title\n\nfirst line\n> second line"));
  return expect(noteTitleOf("x".repeat(200)).length === 81, "long titles are clipped with an ellipsis");
});

test("Search needs every word, case-insensitively", () => {
  expect(noteMatches("Alpha beta GAMMA", "gamma alpha"), "both words");
  expect(!noteMatches("Alpha beta", "alpha delta"), "one word missing");
  return expect(noteMatches("anything", "  "), "blank query matches all");
});

test("create writes <id>.md with the text, leaves no .tmp, and get returns it", () => {
  const { dir, store } = fresh();
  const note = store.create("# Hello\nworld");
  expect(existsSync(join(dir, `${note.id}.md`)), "file exists");
  expect(readFileSync(join(dir, `${note.id}.md`), "utf8") === "# Hello\nworld", "file text");
  expect(note.title === "Hello" && note.preview === "world", `${note.title}|${note.preview}`);
  expect(files(dir).every((f) => !f.endsWith(".tmp")), files(dir).join());
  return expect(store.get(note.id).text === "# Hello\nworld", "get");
});

test("save replaces the text; identical text does not touch the file", () => {
  const { dir, store } = fresh();
  const note = store.create("one");
  const file = join(dir, `${note.id}.md`);
  setMtime(file, "2020-01-01T00:00:00.000Z");
  const same = store.save(note.id, "one");
  expect(same.updatedAt === "2020-01-01T00:00:00.000Z" && same.rev === note.rev, `unchanged text keeps mtime: ${same.updatedAt}`);
  const next = store.save(note.id, "two");
  expect(next.rev !== note.rev && next.title === "two", "changed text gets a new rev");
  return expect(readFileSync(file, "utf8") === "two" && next.updatedAt > "2020-01-01T00:00:00.000Z", "file rewritten");
});

test("list is newest first, with the id breaking ties, and reads edits made outside the store", () => {
  const { dir, store } = fresh();
  const a = store.create("a");
  const b = store.create("b");
  const c = store.create("c");
  setMtime(join(dir, `${a.id}.md`), "2021-01-01T00:00:00.000Z");
  setMtime(join(dir, `${b.id}.md`), "2023-01-01T00:00:00.000Z");
  setMtime(join(dir, `${c.id}.md`), "2022-01-01T00:00:00.000Z");
  expect(store.list().map((x) => x.title).join() === "b,c,a", store.list().map((x) => x.title).join());
  writeFileSync(join(dir, `${a.id}.md`), "edited outside");
  setMtime(join(dir, `${a.id}.md`), "2024-01-01T00:00:00.000Z");
  expect(store.list().map((x) => x.title).join() === "edited outside,b,c", "outside edit moves to the top and is re-read");
  setMtime(join(dir, `${b.id}.md`), "2024-01-01T00:00:00.000Z");
  setMtime(join(dir, `${a.id}.md`), "2024-01-01T00:00:00.000Z");
  const tied = store.list().slice(0, 2).map((x) => x.id);
  return expect(tied.join() === [a.id, b.id].sort().join(), "same time sorts by id");
});

test("list(query) filters by body text, and files that are not notes are ignored", () => {
  const { dir, store } = fresh();
  store.create("Groceries\nmilk and eggs");
  store.create("Ideas\nbuild a rocket");
  writeFileSync(join(dir, "README.txt"), "not a note");
  writeFileSync(join(dir, "bad name.md"), "not a note either");
  expect(store.list().length === 2, `${store.list().length} notes`);
  expect(store.list("rocket").map((x) => x.title).join() === "Ideas", "match inside the body");
  return expect(store.list("rocket milk").length === 0, "all words must match");
});

test("delete moves a note with text to .trash and removes it from the list", () => {
  const { dir, store } = fresh();
  const note = store.create("keep me");
  store.delete(note.id);
  expect(!existsSync(join(dir, `${note.id}.md`)), "gone from the folder");
  expect(readFileSync(join(dir, ".trash", `${note.id}.md`), "utf8") === "keep me", "moved to .trash with its text");
  expect(store.list().length === 0, "not listed");
  throws(() => store.get(note.id), /Unknown note/);
  return expect(true, "get after delete throws");
});

test("delete of an empty note removes it without filling the trash; unknown ids are refused", () => {
  const { dir, store } = fresh();
  const note = store.create();
  store.delete(note.id);
  expect(!existsSync(join(dir, ".trash")) || readdirSync(join(dir, ".trash")).length === 0, "trash stays empty");
  throws(() => store.delete(note.id), /Unknown note/);
  throws(() => store.delete("../../etc/passwd"), /Unknown note/);
  return expect(true, "bad ids");
});

test("A trashed id that already exists in .trash gets a timestamp suffix instead of overwriting", () => {
  const { dir, store } = fresh();
  const note = store.create("first");
  store.delete(note.id);
  writeFileSync(join(dir, `${note.id}.md`), "second");
  store.delete(note.id);
  const trashed = readdirSync(join(dir, ".trash"));
  return expect(trashed.length === 2 && trashed.includes(`${note.id}.md`), trashed.join());
});

test("save refuses a deleted note so another window cannot resurrect it", () => {
  const { store } = fresh();
  const note = store.create("text");
  store.delete(note.id);
  return throws(() => store.save(note.id, "late save"), /Unknown note/);
});

test("Many saves fired at once land in call order; the last one wins and no temp file is left", async () => {
  const { dir, store } = fresh();
  const a = store.create("a0");
  const b = store.create("b0");
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => [store.save(a.id, `a${i + 1}`), store.save(b.id, `b${i + 1}`)])));
  expect(results.length === 50, "all settled");
  expect(readFileSync(join(dir, `${a.id}.md`), "utf8") === "a50", "a last write");
  expect(readFileSync(join(dir, `${b.id}.md`), "utf8") === "b50", "b last write");
  expect(files(dir).every((f) => f.endsWith(".md")), files(dir).join());
  expect(store.list().map((x) => x.title).sort().join() === "a50,b50", "list matches the files");
  // 새 저장소로 다시 열어도 같다
  return expect(new NoteStore(dir).list().length === 2, "reopened store sees both");
});

test("Creating notes at the same moment gives distinct ids", () => {
  const { store } = fresh();
  const ids = new Set(Array.from({ length: 200 }, () => store.create("x").id));
  return expect(ids.size === 200, `${ids.size} distinct ids`);
});

test("Text limits and non-string text are rejected", () => {
  const { store } = fresh();
  const note = store.create("ok");
  throws(() => store.save(note.id, "x".repeat(200_001)), /limited to 200,000 characters/);
  throws(() => store.save(note.id, 42 as unknown as string), /needs text/);
  expect(store.get(note.id).text === "ok", "nothing was written");
  return expect(store.create("y".repeat(200_000)).text.length === 200_000, "the limit itself is allowed");
});

test("Palette lists Notes: Open with its key and Notes: New Note; the key is bound once and only outside the editor", () => {
  const list = paletteCommands();
  const open = list.find((c) => c.command === "notes");
  expect(open?.title === "Notes: Open" && open.keycaps.join("") === "⌥⌘N", JSON.stringify(open));
  expect(list.find((c) => c.command === "newNote")?.title === "Notes: New Note", "new note entry");
  const bound = BINDINGS.filter((b) => b.keys.join() === "Alt+Meta+KeyN");
  return expect(bound.length === 1 && bound[0]!.command === "notes" && bound[0]!.when === "notEditor", JSON.stringify(bound));
});

let failed = 0;
for (const { name, run } of cases) {
  try {
    console.log(`PASS ${name}: ${await run()}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${(error as Error).message}`);
  }
}
if (failed) process.exit(1);
console.log(`notes: ${cases.length} cases passed`);
