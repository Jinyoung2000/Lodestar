import type { BoardStore } from "./board";
import type { Store } from "./store";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type BoardHandlerDeps = { store: Store; board: BoardStore; publishBoard: () => void; topWorkspaceOf: (id: unknown) => string | null };

export function boardHandlers(deps: BoardHandlerDeps): HandlersFor<MethodsIn<"board">> {
  const { store, board, publishBoard, topWorkspaceOf } = deps;
  return {
    "board.get": () => board.get(),
    "board.createCard": (params) => {
      const input = params && typeof params === "object" ? params : ({} as typeof params);
      const workspaceId = topWorkspaceOf(input.workspaceId);
      for (const agentId of Array.isArray(input.agentIds) ? input.agentIds : []) store.agent(agentId);
      if (input.source) store.agent(input.source.agentId);
      const card = board.createCard({ ...input, workspaceId });
      publishBoard();
      return card;
    },
    "board.updateCard": ({ id, patch }) => {
      const next = patch && typeof patch === "object" && patch.workspaceId !== undefined ? { ...patch, workspaceId: topWorkspaceOf(patch.workspaceId) } : patch;
      const card = board.updateCard(id, next);
      publishBoard();
      return card;
    },
    "board.deleteCard": ({ id }) => {
      board.deleteCard(id);
      publishBoard();
      return null;
    },
    "board.moveCard": ({ id, columnId, index }) => {
      const card = board.moveCard(id, columnId, index);
      publishBoard();
      return card;
    },
    "board.linkAgent": ({ cardId, agentId }) => {
      store.agent(agentId);
      const card = board.linkAgent(cardId, agentId);
      publishBoard();
      return card;
    },
    "board.unlinkAgent": ({ cardId, agentId }) => {
      const card = board.unlinkAgent(cardId, agentId);
      publishBoard();
      return card;
    },
    "board.addColumn": ({ name }) => {
      const column = board.addColumn(name);
      publishBoard();
      return column;
    },
    "board.renameColumn": ({ id, name }) => {
      const column = board.renameColumn(id, name);
      publishBoard();
      return column;
    },
    "board.deleteColumn": ({ id }) => {
      board.deleteColumn(id);
      publishBoard();
      return null;
    },
    "board.moveColumn": ({ id, index }) => {
      board.moveColumn(id, index);
      publishBoard();
      return null;
    },
    "board.setLabelColor": ({ label, color }) => {
      board.setLabelColor(label, color);
      publishBoard();
      return null;
    },
  };
}
