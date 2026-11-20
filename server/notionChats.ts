import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME } from "./store";

// Notion 페이지마다 붙은 전용 대화(일반 Lodestar 세션)의 목록. 키는 notionPageKey(url), 값은 세션 id 와 페이지 주소, 제목이다(보드 카드가 페이지로 되돌아가는 링크에 쓴다).
// 파일은 임시 파일에 쓴 뒤 rename 으로 바꾸고, 읽을 수 없는 파일은 비어 있는 것으로 시작한다.
export type NotionChat = { agentId: string; url: string; title: string };

export class NotionChatStore {
  private chats: Record<string, NotionChat>;

  constructor(private file: string = join(HOME, "notion-chats.json")) {
    this.chats = this.load();
  }

  private load(): Record<string, NotionChat> {
    if (!existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const out: Record<string, NotionChat> = {};
      for (const [key, value] of Object.entries(raw as Record<string, Partial<NotionChat>>)) {
        if (value && typeof value.agentId === "string" && typeof value.url === "string") out[key] = { agentId: value.agentId, url: value.url, title: typeof value.title === "string" ? value.title : "" };
      }
      return out;
    } catch {
      return {};
    }
  }

  // 화면에 보내는 모양: 페이지 키 -> 세션 id
  wire(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.chats).map(([key, chat]) => [key, chat.agentId]));
  }

  get(key: string): NotionChat | null {
    return this.chats[key] ?? null;
  }

  ofAgent(agentId: string): NotionChat | null {
    return Object.values(this.chats).find((chat) => chat.agentId === agentId) ?? null;
  }

  set(key: string, chat: NotionChat) {
    this.chats[key] = chat;
    this.save();
  }

  remove(key: string) {
    if (!(key in this.chats)) return;
    delete this.chats[key];
    this.save();
  }

  // 지워진 세션을 가리키는 항목을 정리한다. 바뀌었으면 true.
  prune(liveAgentIds: Set<string>): boolean {
    const dead = Object.keys(this.chats).filter((key) => !liveAgentIds.has(this.chats[key].agentId));
    for (const key of dead) delete this.chats[key];
    if (dead.length) this.save();
    return dead.length > 0;
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.chats, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
