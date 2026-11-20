import type { ServerEvent, UserAttachment } from "../shared/protocol";
import type { AgentRunner } from "./agents";
import type { BoardStore } from "./board";
import { discardUpload, resolveFiles } from "./fileAttach"; // FILEATTACH
import { generateHandoff, readHandoff, saveHandoff } from "./handoff";
import { saveImage } from "./images";
import { sessionFiles } from "./sessionTouch";
import type { Store } from "./store";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type AgentHandlerDeps = { store: Store; runner: AgentRunner; board: BoardStore; broadcast: (event: ServerEvent) => void };

export function agentHandlers(deps: AgentHandlerDeps): HandlersFor<Exclude<MethodsIn<"agents">, "agents.timelinePage" | "agents.worktreeStatus" | "agents.setLinearIssue" | "agents.respondNotionWrite"> | MethodsIn<"handoff"> | MethodsIn<"diffFeedback"> | MethodsIn<"images"> | MethodsIn<"attachments"> | "app.showAgent"> {
  const { store, runner, board, broadcast } = deps;
  return {
    "agents.list": () => store.agents,
    "agents.create": (params) => {
      if (params.workspaceId !== null) store.workspace(params.workspaceId);
      if (params.boardCardId !== undefined) board.card(params.boardCardId);
      return runner.create(params);
    },
    // HANDOFF: 인계 문서. 만드는 데 모델을 한 번 부르므로 응답이 늦을 수 있다(화면이 칩에 진행 표시를 둔다).
    "handoff.create": async ({ agentId }) => {
      runner.assertClaude(agentId, "Handoff"); // CODEX
      const agent = store.agent(agentId);
      // FIX4A: 문서 질문이 이 세션이 만진 파일을 폴더 전체의 변경과 구분하게, Session 범위와 같은 장부의 목록을 넘긴다
      const files = agent.workspaceId === null ? null : (await sessionFiles(agent, store).catch(() => null))?.map((f) => f.rel) ?? null;
      return generateHandoff(agent, files);
    },
    "handoff.read": ({ id }) => readHandoff(id),
    "handoff.save": ({ id, text }) => {
      saveHandoff(id, text);
      return null;
    },
    // B3: 응답 중이면 steer 가 아닌 한 큐에 들어간다. 전송 자체(모델 호출)는 기다리지 않고, 큐에 들어갔는지만 바로 돌려준다.
    "agents.send": async ({ agentId, prompt, steer, images, files }) => {
      // FILEATTACH: 파일은 여기서 먼저 확인한다(사라졌으면 이 호출이 실패해 화면이 입력을 그대로 두고 알린다). 모델에는 글 뒤에 경로 블록이 붙은 메시지가 가고, 말풍선에는 글(display)과 파일 칩이 보인다.
      const attached = await resolveFiles(files);
      const queued = runner.willQueue(agentId, steer === true);
      // fixB: 이미지는 칩(말풍선 위 썸네일)과 모델에 가는 image 블록으로 함께 간다. 글이 없는 메시지의 말풍선은 칩만 둔다.
      const chips: UserAttachment[] = [...(images ?? []).map((image) => ({ kind: "image" as const, ...image })), ...attached.chips];
      const attach = chips.length ? { display: prompt, attachments: chips } : {};
      void runner.send(agentId, attached.model(prompt),{ steer: steer === true, ...attach }).catch((error) => console.error("[agent] send failed", error));
      return { queued };
    },
    // fixB: 입력창 이미지 저장
    "images.upload": (params) => saveImage(params),
    // FILEATTACH: 보내기 전에 칩을 지운 업로드 폴백 파일 정리
    "attachments.discard": ({ id }) => discardUpload(id),
    "agents.dequeue": ({ agentId, queueId }) => runner.dequeue(agentId, queueId),
    "agents.cancelSteering": ({ agentId, steeringId }) => runner.cancelSteering(agentId, steeringId),
    // DIFFFB: 쌓인 diff 피드백
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
      void runner.sendQueuedNow(agentId, queueId).catch((error) => console.error("[agent] send queued failed", error));
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
    "agents.respondPermission": ({ agentId, itemId, decision }) => {
      runner.respondPermission(agentId, itemId, decision);
      return null;
    },
    // fixB: 질문 답과 계획 승인
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
    // B2: 체크포인트 복원과 Redo
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
  };
}
