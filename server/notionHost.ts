import type { Agent, FileRef, ImageRef, PermissionMode, EffortLevel, ServerEvent, NotionPageView } from "../shared/protocol";
import { pageContext } from "../shared/notionContext";
import { isNotionUrl, notionPageKey, notionRefToUrl } from "../shared/notionLink";
import type { NotionHooks, CreateParams } from "./agents";
import type { AgentRunner } from "./agents";
import type { BoardStore } from "./board";
import { NotionChatStore } from "./notionChats";
import { NotionService, type NotionRead } from "./notion";
import type { Store } from "./store";

// Notion 연동을 데몬에 꽂는 곳. 서비스(읽기와 승인된 쓰기), 페이지 전용 대화의 목록, 에이전트 세션에 붙는 도구의 호스트, RPC 처리기를 한 군데서 만든다.
// server/index.ts 는 이 파일이 돌려주는 hooks 와 handlers 를 연결만 한다.

// 이 시간 안에 읽은 내용이 있으면 대화를 시작할 때 다시 읽지 않는다.
const FRESH_MS = 2 * 60 * 1000;

export type NotionDeps = { store: Store; board: BoardStore; runner: Pick<AgentRunner, "create" | "respondNotionWrite">; broadcast: (event: ServerEvent) => void; publishBoard: () => void; service?: NotionService; chats?: NotionChatStore };

export function wirePage(read: NotionRead): NotionPageView {
  const { enhanced: _enhanced, ...page } = read.page;
  return { page, fetchedAt: read.fetchedAt, costUsd: read.costUsd };
}

export function createNotion(deps: NotionDeps) {
  const { store, board, runner, broadcast } = deps;
  const service = deps.service ?? new NotionService(broadcast);
  const chats = deps.chats ?? new NotionChatStore();
  if (chats.prune(store.allAgentIds)) broadcast({ type: "notionChats", chats: chats.wire() });

  const hooks: NotionHooks = {
    attach: (agentId, page) => {
      chats.set(notionPageKey(page.url), { agentId, url: page.url, title: page.title });
      broadcast({ type: "notionChats", chats: chats.wire() });
    },
    host: (agentId, ask) => {
      const chat = chats.ofAgent(agentId);
      return {
        read: (ref) => service.read(notionRefToUrl(ref)).then((r) => r.page, () => null),
        cachedTitle: (ref) => service.cached(notionRefToUrl(ref))?.page.title ?? null,
        ask,
        write: (tool, args) => service.write(tool, args),
        changed: (ref) => service.changed(notionRefToUrl(ref)),
        page: chat ? { url: chat.url, title: chat.title } : null,
        addCards: chat
          ? (cards) => {
              const made = cards.map((card) => board.createCard({ title: card.title, body: card.body ?? "", links: [{ url: chat.url, title: chat.title || null }] }));
              deps.publishBoard();
              return made.map((c) => ({ id: c.id, title: c.title }));
            }
          : null,
        startSession: chat ? (prompt) => broadcast({ type: "notionStartSession", agentId, prompt }) : null,
      };
    },
  };

  const handlers = {
    "notion.page.cached": ({ url }: { url: string }) => {
      const read = isNotionUrl(url) ? service.cached(url) : null;
      return read ? wirePage(read) : null;
    },
    "notion.page.read": async ({ url }: { url: string }) => {
      if (!isNotionUrl(url)) throw new Error("That is not a Notion link");
      return wirePage(await service.read(url));
    },
    "notion.chats.list": () => chats.wire(),
    "notion.chat.start": async (params: { url: string; prompt: string; permissionMode: PermissionMode; model: string | null; effort: EffortLevel | null; images?: ImageRef[]; files?: FileRef[] }): Promise<Agent> => {
      if (!isNotionUrl(params.url)) throw new Error("That is not a Notion link");
      const cached = service.cached(params.url);
      const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < FRESH_MS ? cached : null;
      const read = fresh ?? (await service.read(params.url).catch((error) => {
        if (cached) return cached;
        throw error;
      }));
      const { page } = read;
      const create: CreateParams = {
        workspaceId: null,
        prompt: params.prompt,
        permissionMode: params.permissionMode,
        model: params.model,
        effort: params.effort,
        worktree: null,
        ...(params.images?.length ? { images: params.images } : {}),
        ...(params.files?.length ? { files: params.files } : {}),
        notionContext: { text: pageContext(page, read.fetchedAt), label: `Notion: ${page.title}`, url: page.url, title: page.title },
      };
      return runner.create(create);
    },
    "notion.chat.reset": ({ url }: { url: string }) => {
      chats.remove(notionPageKey(url));
      broadcast({ type: "notionChats", chats: chats.wire() });
      return null;
    },
    "agents.respondNotionWrite": ({ agentId, itemId, apply, feedback }: { agentId: string; itemId: string; apply: boolean; feedback?: string }) => {
      runner.respondNotionWrite(agentId, itemId, apply, feedback);
      return null;
    },
  };

  return { service, chats, hooks, handlers };
}
