import type { ServerEvent } from "../shared/protocol";
import type { InboxFetcher, InboxStore } from "./inbox";
import type { MentionPipeline } from "./mentions";
import { T } from "./strings";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type InboxHandlerDeps = { inbox: InboxFetcher; inboxStore: InboxStore; mentions: MentionPipeline; broadcast: (event: ServerEvent) => void; topWorkspaceOf: (id: unknown) => string | null };

function inboxIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some((id) => typeof id !== "string")) throw new Error(T.errInboxIds);
  return ids as string[];
}

export function inboxHandlers(deps: InboxHandlerDeps): HandlersFor<MethodsIn<"inbox">> {
  const { inbox, inboxStore, mentions, broadcast, topWorkspaceOf } = deps;
  const publishInbox = () => {
    const state = inbox.state();
    broadcast({ type: "inbox", inbox: state });
    return state;
  };
  return {
    "inbox.get": () => inbox.state(),
    "inbox.refresh": () => inbox.refresh(),
    "inbox.markRead": ({ ids, read }) => {
      const list = inboxIds(ids);
      if (typeof read !== "boolean") throw new Error(T.errInboxFlag("read"));
      inboxStore.setRead(list, read);
      return publishInbox();
    },
    "inbox.archive": ({ ids, archived }) => {
      const list = inboxIds(ids);
      if (typeof archived !== "boolean") throw new Error(T.errInboxFlag("archived"));
      inboxStore.setArchived(list, archived);
      return publishInbox();
    },
    "inbox.thread": ({ id }) => inbox.thread(id),
    "inbox.addToBoard": ({ id, workspaceId }) => mentions.addToBoard(id, topWorkspaceOf(workspaceId)),
    "inbox.reanalyze": ({ id }) => {
      mentions.reanalyze(id);
      return inbox.state();
    },
    "inbox.notRequest": ({ id }) => {
      mentions.notRequest(id);
      return inbox.state();
    },
  };
}
