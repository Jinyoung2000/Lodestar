import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isNotionUrl, notionTitleFromUrl, singleEmoji } from "../shared/notionLink";
import { cleanTitle, MAX_NOTION_PINS, pinMatches, sanitizePins, type NotionPin, type NotionPinInput, type NotionPinPatch } from "../shared/notionPins";
import { HOME } from "./store";

const PINS_FILE = join(HOME, "notion-pins.json");

// 사이드바 Notion 묶음의 고정 목록(~/.agent-nav/notion-pins.json). 값은 전부 여기서 검사하고, 파일은 임시 파일에 쓴 뒤 rename 으로 바꿔서 도중에 끊겨도 반쪽 파일이 남지 않는다.
export class NotionPinStore {
  private pins: NotionPin[];

  constructor(private readonly file: string = PINS_FILE) {
    mkdirSync(dirname(file), { recursive: true });
    this.pins = this.load();
  }

  list(): NotionPin[] {
    return this.pins;
  }

  private load(): NotionPin[] {
    if (!existsSync(this.file)) return [];
    try {
      return sanitizePins(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      // 읽을 수 없는 파일은 덮어쓰지 않고 옆으로 치운다.
      const aside = `${this.file}.corrupt-${Date.now()}`;
      renameSync(this.file, aside);
      console.error(`[notion] pins file is unreadable, moved to ${aside}`);
      return [];
    }
  }

  private commit(next: NotionPin[]) {
    this.pins = next;
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, this.file);
  }

  // 같은 페이지가 이미 고정돼 있으면 새로 만들지 않고 그 항목을 돌려준다(added 가 false).
  add(input: NotionPinInput): { pin: NotionPin; added: boolean } {
    if (!input || typeof input.url !== "string" || !isNotionUrl(input.url)) throw new Error("Only Notion page links can be pinned.");
    const existing = this.pins.find((p) => pinMatches(p, input.url));
    if (existing) return { pin: existing, added: false };
    if (this.pins.length >= MAX_NOTION_PINS) throw new Error(`You can pin up to ${MAX_NOTION_PINS} Notion pages.`);
    const given = cleanTitle(input.title);
    const guessed = notionTitleFromUrl(input.url);
    const pin: NotionPin = {
      id: randomUUID(),
      title: given || guessed || "Notion page",
      url: new URL(input.url).href,
      icon: singleEmoji(input.icon),
      kind: input.kind === "database" ? "database" : "page",
      titleSource: input.titleSource ?? (given ? "page" : "url"),
    };
    this.commit([...this.pins, pin]);
    return { pin, added: true };
  }

  update(id: string, patch: NotionPinPatch): NotionPin {
    const pin = this.require(id);
    const next: NotionPin = { ...pin };
    if (patch && "title" in patch) {
      const title = cleanTitle(patch.title);
      if (!title) throw new Error("The name can't be empty.");
      next.title = title;
      next.titleSource = patch.titleSource === "page" ? "page" : "user";
    }
    if (patch && "icon" in patch) next.icon = singleEmoji(patch.icon);
    if (patch && (patch.kind === "page" || patch.kind === "database")) next.kind = patch.kind;
    this.commit(this.pins.map((p) => (p.id === id ? next : p)));
    return next;
  }

  remove(id: string) {
    this.require(id);
    this.commit(this.pins.filter((p) => p.id !== id));
  }

  // index 는 옮기는 항목을 뺀 목록 안에서의 위치(0 ~ 항목 수)
  move(id: string, index: number): NotionPin[] {
    const pin = this.require(id);
    const rest = this.pins.filter((p) => p.id !== id);
    const at = Math.min(Math.max(Math.trunc(Number(index)) || 0, 0), rest.length);
    this.commit([...rest.slice(0, at), pin, ...rest.slice(at)]);
    return this.pins;
  }

  private require(id: string): NotionPin {
    const pin = this.pins.find((p) => p.id === id);
    if (!pin) throw new Error("That pinned page no longer exists.");
    return pin;
  }
}
