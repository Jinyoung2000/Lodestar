import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { byRecent, isNoteId, noteMatches, notePreviewOf, noteTitleOf, NOTE_MAX_CHARS, type Note, type NoteDoc } from "../shared/notes";
import { T } from "./strings";

export class NoteStore {
  private readonly trashDir: string;
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
        this.cache.delete(id);
      }
    }
    for (const id of this.cache.keys()) if (!seen.has(id)) this.cache.delete(id);
  }
}

function summarize(id: string, text: string, mtime: Date): Note {
  return { id, title: noteTitleOf(text), preview: notePreviewOf(text), updatedAt: mtime.toISOString(), rev: createHash("sha1").update(text).digest("hex").slice(0, 12) };
}
