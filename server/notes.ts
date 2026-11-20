import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { byRecent, isNoteId, noteMatches, notePreviewOf, noteTitleOf, NOTE_MAX_CHARS, type Note, type NoteDoc } from "../shared/notes";
import { T } from "./strings";

// 메모장 저장소. 메모 하나는 `<dir>/<id>.md` 파일 하나이고, 지운 메모는 `<dir>/.trash/` 로 옮긴다(영구 삭제 경로는 빈 메모뿐).
// 쓰기는 같은 폴더의 임시 파일에 쓴 뒤 rename 으로 바꿔서 도중에 끊겨도 반쪽 파일이 남지 않는다. 데몬이 한 프로세스이고 모든 파일 작업이 동기라서
// 같은 메모에 저장이 동시에 몰려도 호출 순서대로 하나씩 반영된다(나중 호출이 이긴다).
export class NoteStore {
  private readonly trashDir: string;
  // 목록과 검색이 파일을 매번 다시 읽지 않도록 본문과 파일 상태를 들고 있는다. list 가 디스크와 맞춰 본다(바깥에서 고친 파일도 따라온다).
  private cache = new Map<string, { text: string; mtimeMs: number; size: number; note: Note }>();
  private tmpCounter = 0;

  constructor(readonly dir: string) {
    this.trashDir = join(dir, ".trash");
    mkdirSync(dir, { recursive: true });
  }

  list(query = ""): Note[] {
    this.sync();
    const notes: Note[] = [];
    for (const entry of this.cache.values()) if (noteMatches(entry.text, query)) notes.push(entry.note);
    return notes.sort(byRecent);
  }

  get(id: string): NoteDoc {
    this.checkId(id);
    const file = this.file(id);
    if (!existsSync(file)) {
      this.cache.delete(id);
      throw new Error(T.errUnknownNote(id));
    }
    const entry = this.load(id);
    return { ...entry.note, text: entry.text };
  }

  create(text = ""): NoteDoc {
    this.checkText(text);
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    this.write(id, text);
    return this.get(id);
  }

  save(id: string, text: string): Note {
    this.checkId(id);
    this.checkText(text);
    if (!existsSync(this.file(id))) {
      this.cache.delete(id);
      throw new Error(T.errUnknownNote(id));
    }
    const current = this.load(id);
    if (current.text === text) return current.note;
    this.write(id, text);
    return this.load(id).note;
  }

  // 본문이 있는 메모는 notes/.trash 로 옮긴다(같은 이름이 있으면 뒤에 시각을 붙인다). 빈 메모는 잃을 글이 없어 그냥 지운다.
  delete(id: string): void {
    this.checkId(id);
    const file = this.file(id);
    if (!existsSync(file)) {
      this.cache.delete(id);
      throw new Error(T.errUnknownNote(id));
    }
    if (this.load(id).text.trim() === "") unlinkSync(file);
    else {
      mkdirSync(this.trashDir, { recursive: true });
      let target = join(this.trashDir, `${id}.md`);
      if (existsSync(target)) target = join(this.trashDir, `${id}-${Date.now()}.md`);
      renameSync(file, target);
    }
    this.cache.delete(id);
  }

  private file(id: string) {
    return join(this.dir, `${id}.md`);
  }

  private checkId(id: unknown): asserts id is string {
    if (!isNoteId(id)) throw new Error(T.errUnknownNote(String(id)));
  }

  private checkText(text: unknown): asserts text is string {
    if (typeof text !== "string") throw new Error(T.errNoteText);
    if (text.length > NOTE_MAX_CHARS) throw new Error(T.errNoteLong(NOTE_MAX_CHARS));
  }

  private write(id: string, text: string) {
    const file = this.file(id);
    const tmp = join(this.dir, `.${id}.${process.pid}.${this.tmpCounter++}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    this.cache.delete(id);
  }

  // 캐시에 있고 파일 상태(수정 시각과 크기)가 그대로면 캐시, 아니면 다시 읽는다.
  private load(id: string) {
    const stat = statSync(this.file(id));
    const hit = this.cache.get(id);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
    const text = readFileSync(this.file(id), "utf8");
    const entry = { text, mtimeMs: stat.mtimeMs, size: stat.size, note: summarize(id, text, stat.mtime) };
    this.cache.set(id, entry);
    return entry;
  }

  private sync() {
    const seen = new Set<string>();
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".md")) continue;
      const id = name.slice(0, -3);
      if (!isNoteId(id)) continue;
      seen.add(id);
      try {
        this.load(id);
      } catch {
        // 읽는 사이에 지워진 파일은 다음 목록에서 빠진다.
        this.cache.delete(id);
      }
    }
    for (const id of this.cache.keys()) if (!seen.has(id)) this.cache.delete(id);
  }
}

function summarize(id: string, text: string, mtime: Date): Note {
  return { id, title: noteTitleOf(text), preview: notePreviewOf(text), updatedAt: mtime.toISOString(), rev: createHash("sha1").update(text).digest("hex").slice(0, 12) };
}
