import type { ServerEvent, UserAttachment } from "../shared/protocol";
import type { AgentRunner } from "./agents";
import type { BoardStore } from "./board";
import { discardUpload, resolveFiles } from "./fileAttach";
import { generateHandoff, readHandoff, saveHandoff } from "./handoff";
import { saveImage } from "./images";
import { join } from "node:path";
import { resolveInside } from "./files";
import { openWithDefaultApp } from "./reveal";
import { sessionFiles } from "./sessionTouch";
import { HOME, type Store } from "./store";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type AgentHandlerDeps = { store: Store; runner: AgentRunner; board: BoardStore; broadcast: (event: ServerEvent) => void };

export function agentHandlers(deps: AgentHandlerDeps): HandlersFor<Exclude<MethodsIn<"agents">, "agents.timelinePage" | "agents.worktreeStatus" | "agents.setLinearIssue" | "agents.respondNotionWrite" | "agents.moveToFolder"> | MethodsIn<"handoff"> | MethodsIn<"diffFeedback"> | MethodsIn<"images"> | MethodsIn<"attachments"> | "app.showAgent"> {
  const { store, runner, board, broadcast } = deps;
  return {
    "agents.list": () => store.agents,
    "agents.create": (params) => {
      if (params.workspaceId !== null) store.workspace(params.workspaceId);
      if (params.boardCardId !== undefined) board.card(params.boardCardId);
      return runner.create(params);
    },
    "agents.addFolder": ({ agentId, workspaceId }) => runner.addFolder(agentId, workspaceId),
    "agents.removeFolder": ({ agentId, workspaceId }) => runner.removeFolder(agentId, workspaceId),
    "handoff.create": async ({ agentId }) => {
      runner.assertClaude(agentId, "Handoff");
      const agent = store.agent(agentId);
      const files = agent.workspaceId === null ? null : (await sessionFiles(agent, store).catch(() => null))?.map((f) => f.rel) ?? null;
      return generateHandoff(agent, files);
    },
    "handoff.read": ({ id }) => readHandoff(id),
    "handoff.save": ({ id, text }) => {
      saveHandoff(id, text);
      return null;
    },
    "agents.send": async ({ agentId, prompt, steer, images, files }) => {
      const attached = await resolveFiles(files);
      const chips: UserAttachment[] = [...(images ?? []).map((image) => ({ kind: "image" as const, ...image })), ...attached.chips];
      const attach = chips.length ? { display: prompt, attachments: chips } : {};
      return runner.send(agentId, attached.model(prompt), { steer: steer === true, ...attach });
    },
    "images.upload": (params) => saveImage(params),
    "attachments.discard": ({ id }) => discardUpload(id),
    "agents.dequeue": ({ agentId, queueId }) => runner.dequeue(agentId, queueId),
    "agents.cancelSteering": ({ agentId, steeringId }) => runner.cancelSteering(agentId, steeringId),
    "diffFeedback.list": ({ agentId }) => store.diffFeedback(store.agent(agentId).id),
    "diffFeedback.add": ({ agentId, item }) => runner.addDiffFeedback(agentId, item),
    "diffFeedback.update": ({ agentId, id, text }) => {
      runner.updateDiffFeedback(agentId, id, text);
      return null;
    },
    "diffFeedback.remove": ({ agentId, id }) => {
      runner.removeDiffFeedback(agentId, id);
      return null;
    },
    "diffFeedback.clear": ({ agentId }) => {
      runner.clearDiffFeedback(agentId);
      return null;
    },
    "diffFeedback.send": ({ agentId, text, steer, ids }) => runner.sendDiffFeedback(agentId, { text, steer, ids }),
    "agents.sendQueuedNow": async ({ agentId, queueId }) => {
      await runner.sendQueuedNow(agentId, queueId);
      return null;
    },
    "agents.interrupt": async ({ agentId }) => {
      await runner.interrupt(agentId);
      return null;
    },
    "agents.timeline": ({ agentId }) => store.timeline(agentId),
    "agents.setPermissionMode": async ({ agentId, mode }) => {
      await runner.setPermissionMode(agentId, mode);
      return null;
    },
    "agents.setModel": ({ agentId, model }) => {
      runner.setModel(agentId, model);
      return null;
    },
    "agents.setEffort": ({ agentId, effort }) => {
      runner.setEffort(agentId, effort);
      return null;
    },
    "agents.switchHarness": async ({ agentId, harness, model, effort }) => {
      await runner.switchHarness(agentId, harness, model, effort);
      return null;
    },
    "agents.respondPermission": ({ agentId, itemId, decision }) => {
      runner.respondPermission(agentId, itemId, decision);
      return null;
    },
    "agents.answerQuestion": ({ agentId, itemId, answers }) => {
      runner.answerQuestion(agentId, itemId, answers);
      return null;
    },
    "agents.respondPlan": (params) => {
      runner.respondPlan(params.agentId, params.itemId, params.approve ? { approve: true, mode: params.mode } : { approve: false, feedback: params.feedback });
      return null;
    },
    "agents.remove": async ({ agentId, removeWorktree }) => {
      await runner.remove(agentId, removeWorktree);
      return null;
    },
    "agents.fork": ({ agentId, beforeItemId }) => (beforeItemId ? runner.forkBefore(agentId, beforeItemId) : runner.fork(agentId)),
    "agents.restoreCheckpoint": ({ agentId, itemId }) => runner.restoreCheckpoint(agentId, itemId),
    "agents.previewCheckpoint": ({ agentId, itemId }) => runner.previewCheckpoint(agentId, itemId),
    "agents.cancelRestore": ({ agentId }) => {
      runner.cancelRestore(agentId);
      return null;
    },
    "agents.redoCheckpoint": ({ agentId }) => runner.redoCheckpoint(agentId),
    "agents.checkpointModes": ({ agentId }) => runner.checkpointModes(agentId),
    "app.showAgent": ({ agentId }) => {
      store.agent(agentId);
      broadcast({ type: "showAgent", agentId });
      return null;
    },
    "agents.markRead": ({ agentId, read }) => {
      runner.setRead(agentId, read);
      return null;
    },
    "agents.setOpen": ({ agentIds }, client) => {
      runner.setOpenAgents(client, Array.isArray(agentIds) ? agentIds.filter((id) => typeof id === "string") : []);
      return null;
    },
    "agents.setPinned": ({ agentId, pinned }) => {
      runner.setPinned(agentId, pinned);
      return null;
    },
    "agents.setDone": ({ agentId, done }) => {
      runner.setDone(agentId, done);
      return null;
    },
    "agents.rename": ({ agentId, title }) => {
      runner.rename(agentId, title);
      return null;
    },
    "agents.openChatFile": async ({ agentId, path }) => {
      const agent = store.agent(agentId);
      await openWithDefaultApp(resolveInside(join(HOME, "chats", agent.id), String(path)));
      return null;
    },
  };
}
