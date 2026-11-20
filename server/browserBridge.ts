import { randomUUID } from "node:crypto";
import type { BrowserSharedPage, BrowserToolName, BrowserToolOutput, ServerEvent, ServerMessage } from "../shared/protocol";
import { T } from "./strings";

// 에이전트의 Browser 도구가 화면의 <webview> 까지 가는 길. 도구 핸들러는 데몬에서 돌고, 페이지를 만지는 일은 Electron 메인 프로세스만 한다.
// 그래서 데몬은 공유를 올린 화면(WebSocket 연결)에 browserTool 이벤트를 보내고, 화면이 메인에 시키고 나서 browser.toolResult 로 답한다.
// 데몬이 아는 것은 "어느 세션에 어느 탭이 공유됐는가" 뿐이다. 공유 안 된 탭과 다른 세션의 탭은 여기서 거절한다(화면도 한 번 더 확인한다).

// ws 의 WebSocket 이 이 모양을 만족한다. 시험은 가짜로 바꿔 끼운다.
export type BridgeClient = { send(text: string): void };

export const TOOL_TIMEOUT_MS = 30_000;
const OPEN_TIMEOUT_MS = 120_000;
const MAX_SHARES = 50;
const MAX_TEXT = 100_000;

type Pending = { client: BridgeClient; agentId: string; resolve: (output: BrowserToolOutput) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class BrowserBridge {
  // 화면(연결)마다 공유 목록과, 공유되지 않은 채 열린 탭 수. 목록이 비어도 항목을 남겨 두어야 open_browser_page 가 새 탭을 열 화면을 찾는다.
  private shares = new Map<BridgeClient, { pages: BrowserSharedPage[]; open: number }>();
  private pending = new Map<string, Pending>();

  constructor(private timeoutMs = TOOL_TIMEOUT_MS) {}

  // 이 연결이 올린 공유 목록을 통째로 바꾼다. 모양이 맞지 않는 항목은 버린다.
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

  // 연결이 끊기면 그 연결의 공유가 사라지고, 기다리던 호출은 실패한다.
  dropClient(client: BridgeClient) {
    this.shares.delete(client);
    for (const [id, pending] of [...this.pending]) if (pending.client === client) this.fail(id, new Error(T.errBrowserDisconnected));
  }

  // 이 세션에 공유된 페이지(공유를 올린 연결과 함께)
  pagesFor(agentId: string): { client: BridgeClient; page: BrowserSharedPage }[] {
    const out: { client: BridgeClient; page: BrowserSharedPage }[] = [];
    for (const [client, { pages }] of this.shares) for (const page of pages) if (page.agentId === agentId) out.push({ client, page });
    return out;
  }

  // 공유되지 않은 채 열린 탭 수(모든 화면 합계)
  unsharedCount(): number {
    let total = 0;
    for (const { open } of this.shares.values()) total += open;
    return total;
  }

  // 새 탭을 열 화면. 이 세션의 공유가 있는 화면을 먼저 쓰고, 없으면 가장 최근에 연결한 화면이다. 도구를 받을 화면이 없으면 null.
  openTarget(agentId: string): BridgeClient | null {
    const own = this.pagesFor(agentId)[0]?.client;
    if (own) return own;
    let last: BridgeClient | null = null;
    for (const client of this.shares.keys()) last = client;
    return last;
  }

  // pageId 를 줬으면 그 페이지가 이 세션 것이어야 한다. 안 줬으면 공유된 페이지가 하나일 때만 그것을 쓴다.
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

  // open_browser_page: 화면이 Browser 탭을 열고(url 이 없으면 공유할 열린 탭을 사용자에게 묻고) 결과 글을 돌려준다. 사용자가 고르는 시간이 있어 기다리는 시간이 길다.
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

  // 화면이 돌려준 결과. 호출을 보낸 그 연결이 아니면 무시한다.
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
