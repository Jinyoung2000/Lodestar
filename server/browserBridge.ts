import { randomUUID } from "node:crypto";
import type { BrowserSharedPage, BrowserToolName, BrowserToolOutput, ServerEvent, ServerMessage } from "../shared/protocol";
import { T } from "./strings";

export type BridgeClient = { send(text: string): void };

export const TOOL_TIMEOUT_MS = 30_000;
const OPEN_TIMEOUT_MS = 120_000;
const MAX_SHARES = 50;
const MAX_TEXT = 100_000;

type Pending = { client: BridgeClient; agentId: string; resolve: (output: BrowserToolOutput) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class BrowserBridge {
  private shares = new Map<BridgeClient, { pages: BrowserSharedPage[]; open: number }>();
  private pending = new Map<string, Pending>();

  constructor(private timeoutMs = TOOL_TIMEOUT_MS) {}

  setShares(client: BridgeClient, pages: unknown, open: unknown = 0) {
    const list = Array.isArray(pages) ? pages : [];
    const valid: BrowserSharedPage[] = [];
    for (const page of list.slice(0, MAX_SHARES)) {
      const p = page as Partial<BrowserSharedPage> | null;
      if (!p || typeof p.pageId !== "string" || typeof p.agentId !== "string" || !p.pageId || !p.agentId) continue;
      valid.push({ pageId: p.pageId, agentId: p.agentId, url: typeof p.url === "string" ? p.url.slice(0, 2000) : "", title: typeof p.title === "string" ? p.title.slice(0, 300) : "", visible: p.visible === "active" ? "active" : "hidden" });
    }
    this.shares.set(client, { pages: valid, open: typeof open === "number" && Number.isInteger(open) && open >= 0 ? Math.min(open, 1000) : 0 });
  }

  dropClient(client: BridgeClient) {
    this.shares.delete(client);
    for (const [id, pending] of [...this.pending]) if (pending.client === client) this.fail(id, new Error(T.errBrowserDisconnected));
  }

  pagesFor(agentId: string): { client: BridgeClient; page: BrowserSharedPage }[] {
    const out: { client: BridgeClient; page: BrowserSharedPage }[] = [];
    for (const [client, { pages }] of this.shares) for (const page of pages) if (page.agentId === agentId) out.push({ client, page });
    return out;
  }

  unsharedCount(): number {
    let total = 0;
    for (const { open } of this.shares.values()) total += open;
    return total;
  }

  openTarget(agentId: string): BridgeClient | null {
    const own = this.pagesFor(agentId)[0]?.client;
    if (own) return own;
    let last: BridgeClient | null = null;
    for (const client of this.shares.keys()) last = client;
    return last;
  }

  resolve(agentId: string, pageId?: string): { client: BridgeClient; page: BrowserSharedPage } {
    const mine = this.pagesFor(agentId);
    if (mine.length === 0) throw new Error(T.errBrowserNoPages);
    if (pageId) {
      const found = mine.find((m) => m.page.pageId === pageId);
      if (!found) throw new Error(T.errBrowserNotShared(pageId));
      return found;
    }
    if (mine.length > 1) throw new Error(T.errBrowserPickPage(mine.map((m) => m.page.pageId)));
    return mine[0];
  }

  async call(agentId: string, pageId: string | undefined, tool: BrowserToolName, args: Record<string, unknown>): Promise<{ page: BrowserSharedPage; output: BrowserToolOutput }> {
    const { client, page } = this.resolve(agentId, pageId);
    const id = randomUUID();
    const event: ServerEvent = { type: "browserTool", id, agentId, pageId: page.pageId, tool, args };
    const output = await new Promise<BrowserToolOutput>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(id, new Error(T.errBrowserTimeout)), this.timeoutMs);
      this.pending.set(id, { client, agentId, resolve, reject, timer });
      try {
        client.send(JSON.stringify({ event } satisfies ServerMessage));
      } catch (error) {
        this.fail(id, error instanceof Error ? error : new Error(String(error)));
      }
    });
    return { page, output };
  }

  async open(agentId: string, url: string | null, forceNew: boolean): Promise<BrowserToolOutput> {
    const client = this.openTarget(agentId);
    if (!client) throw new Error(T.errBrowserNoWindow);
    const id = randomUUID();
    const event: ServerEvent = { type: "browserOpen", id, agentId, url, forceNew };
    return new Promise<BrowserToolOutput>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(id, new Error(T.errBrowserTimeout)), Math.max(this.timeoutMs, OPEN_TIMEOUT_MS));
      this.pending.set(id, { client, agentId, resolve, reject, timer });
      try {
        client.send(JSON.stringify({ event } satisfies ServerMessage));
      } catch (error) {
        this.fail(id, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  settle(client: BridgeClient, id: string, result: BrowserToolOutput | undefined, error: string | undefined) {
    const pending = this.pending.get(id);
    if (!pending || pending.client !== client) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (error !== undefined) pending.reject(new Error(String(error).slice(0, 2000)));
    else pending.resolve(normalize(result));
  }

  private fail(id: string, error: Error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }
}

function normalize(result: BrowserToolOutput | undefined): BrowserToolOutput {
  const out: BrowserToolOutput = {};
  if (result && typeof result.text === "string") out.text = result.text.slice(0, MAX_TEXT);
  if (result && typeof result.image === "string" && result.image.length < 12 * 1024 * 1024) out.image = result.image;
  return out;
}
