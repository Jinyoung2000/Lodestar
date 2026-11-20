import type { BoardStore } from "./board";
import type { Store } from "./store";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type BoardHandlerDeps = { store: Store; board: BoardStore; publishBoard: () => void; topWorkspaceOf: (id: unknown) => string | null };

export function boardHandlers(deps: BoardHandlerDeps): HandlersFor<MethodsIn<"board">> {
  const { store, board, publishBoard, topWorkspaceOf } = deps;
  const published = <T>(value: T): T => {
    publishBoard();
    return value;
  };
  return {
    "board.get": () => board.get(),
    "board.createCard": (params) => {
      const input = params && typeof params === "object" ? params : ({} as typeof params);
      const workspaceId = topWorkspaceOf(input.workspaceId);
      for (const agentId of Array.isArray(input.agentIds) ? input.agentIds : []) store.agent(agentId);
      if (input.source) store.agent(input.source.agentId);
      return published(board.createCard({ ...input, workspaceId }));
    },
    "board.updateCard": ({ id, patch }) => {
      const next = patch && typeof patch === "object" && patch.workspaceId !== undefined ? { ...patch, workspaceId: topWorkspaceOf(patch.workspaceId) } : patch;
      return published(board.updateCard(id, next));
    },
    "board.deleteCard": ({ id }) => {
      board.deleteCard(id);
      return published(null);
    },
    "board.moveCard": ({ id, columnId, index }) => {
      return published(board.moveCard(id, columnId, index));
    },
    "board.linkAgent": ({ cardId, agentId }) => {
      store.agent(agentId);
      return published(board.linkAgent(cardId, agentId));
    },
    "board.unlinkAgent": ({ cardId, agentId }) => {
      return published(board.unlinkAgent(cardId, agentId));
    },
    "board.addColumn": ({ name }) => {
      return published(board.addColumn(name));
    },
    "board.renameColumn": ({ id, name }) => {
      return published(board.renameColumn(id, name));
    },
    "board.deleteColumn": ({ id }) => {
      board.deleteColumn(id);
      return published(null);
    },
    "board.moveColumn": ({ id, index }) => {
      board.moveColumn(id, index);
      return published(null);
    },
    "board.setLabelColor": ({ label, color }) => {
      board.setLabelColor(label, color);
      return published(null);
    },
  };
}
