import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFetchResult, type NotionPageData } from "../shared/notionFetch";
import { notionPageId, notionPageKey } from "../shared/notionLink";
import type { ServerEvent } from "../shared/protocol";
import { runNotionSession, type NotionSessionOutcome, type NotionToolName } from "./notionSession";
import { HOME } from "./store";

export type NotionRead = { page: NotionPageData; fetchedAt: string; costUsd: number | null; turns: number | null };
export type NotionWriteResult = { sent: boolean; text: string; isError: boolean; costUsd: number | null };

type Runner = (tool: NotionToolName, input: Record<string, unknown>) => Promise<NotionSessionOutcome>;

const PAGES_DIR = join(HOME, "notion-pages");
const MAX_MEMORY = 50;

export class NotionService {
  private memory = new Map<string, NotionRead>();
  private inflight = new Map<string, Promise<NotionRead>>();

  constructor(
    private emit: (event: ServerEvent) => void = () => undefined,
    private run: Runner = (tool, input) => runNotionSession(tool, input),
    private dir: string = PAGES_DIR,
  ) {}

  cached(url: string): NotionRead | null {
    const key = notionPageKey(url);
    const hit = this.memory.get(key);
    if (hit) return hit;
    const file = this.fileOf(key);
    if (!file || !existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<NotionRead>;
      if (!raw.page || typeof raw.fetchedAt !== "string" || typeof raw.page.markdown !== "string" || typeof raw.page.enhanced !== "string") return null;
      const read: NotionRead = { page: raw.page as NotionPageData, fetchedAt: raw.fetchedAt, costUsd: raw.costUsd ?? null, turns: raw.turns ?? null };
      this.remember(key, read);
      return read;
    } catch {
      return null;
    }
  }

  read(url: string): Promise<NotionRead> {
    const key = notionPageKey(url);
    const running = this.inflight.get(key);
    if (running) return running;
    const task = this.fetchNow(url, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async fetchNow(url: string, key: string): Promise<NotionRead> {
    const id = notionPageId(url) ?? url;
    const outcome = await this.run("notion-fetch", { id });
    if (!outcome.call) throw new Error("Notion was not called. Try again.");
    if (outcome.call.isError) throw new Error(outcome.call.text.trim().slice(0, 300) || "Notion returned an error");
    const parsed = parseFetchResult(outcome.call.text);
    if (!parsed.ok) throw new Error(parsed.error);
    const read: NotionRead = { page: parsed.page, fetchedAt: new Date().toISOString(), costUsd: outcome.costUsd, turns: outcome.turns };
    this.remember(key, read);
    this.persist(key, read);
    console.log(`[notion] read ${key} chars=${parsed.page.markdown.length} turns=${outcome.turns ?? 0} cost=$${(outcome.costUsd ?? 0).toFixed(4)}`);
    return read;
  }

  async write(tool: "notion-update-page" | "notion-create-pages", args: Record<string, unknown>): Promise<NotionWriteResult> {
    const outcome = await this.run(tool, args);
    const call = outcome.call;
    console.log(`[notion] write ${tool} sent=${!!call} error=${call?.isError ?? "n/a"} turns=${outcome.turns ?? 0} cost=$${(outcome.costUsd ?? 0).toFixed(4)}`);
    if (!call) return { sent: false, text: "The Notion tool was not called, so nothing was written.", isError: true, costUsd: outcome.costUsd };
    return { sent: true, text: call.text, isError: call.isError, costUsd: outcome.costUsd };
  }

  changed(url: string) {
    const key = notionPageKey(url);
    this.memory.delete(key);
    const file = this.fileOf(key);
    if (file) rmSync(file, { force: true });
    this.emit({ type: "notionChanged", key });
  }

  private remember(key: string, read: NotionRead) {
    this.memory.delete(key);
    this.memory.set(key, read);
    if (this.memory.size > MAX_MEMORY) this.memory.delete(this.memory.keys().next().value!);
  }

  private fileOf(key: string): string | null {
    const id = key.startsWith("id:") ? key.slice(3) : null;
    return id && /^[0-9a-f]{32}$/.test(id) ? join(this.dir, `${id}.json`) : null;
  }

  private persist(key: string, read: NotionRead) {
    const file = this.fileOf(key);
    if (!file) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(read), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) {
      console.error("[notion] cache write failed", error);
    }
  }
}
