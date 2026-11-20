import { isSessionShown } from "../shared/attention";
import { needsReview, PLAN_TOOL, QUESTION_TOOL } from "../shared/interactive";
import { isNotionProposeTool } from "../shared/notionMcp";
import type { Agent } from "../shared/protocol";
import { notificationPreview } from "../shared/notificationPreview";
import { clampTitle } from "../shared/sessionTitle";
import { announce } from "./announce";
import { notify } from "./notices";
import { rpc } from "./rpc";
import { focusPane, getState, openAgent, setState } from "./store";
import { S } from "./strings";
import type { PermissionItem } from "./timelineModel";

export type NativeNotification = {
  agentId: string;
  kind: "response" | "approval";
  title: string;
  body: string;
  // 승인 요청이면 그 요청의 항목 id 와 알림 버튼 이름. 질문이면 Allow 가 아니라 Open Session 이다.
  itemId?: string;
  actionLabel?: string;
};

export type NotificationAction = { agentId: string; action: "open" | "allow"; itemId?: string };

// 승인 요청은 바로 풀리는 일이 잦아서 잠깐 기다렸다가 아직 대기 중일 때만 알린다. 응답 완료는 큐의 다음 메시지가 바로 이어지는지 보려고 조금 더 기다린다.
const APPROVAL_DELAY_MS = 250;
const RESPONSE_DELAY_MS = 500;

// 에이전트 상태 변화(데몬의 agent 이벤트)마다 부른다. 화면 낭독 안내는 어디서나 하고, OS 알림은 데스크톱 앱에서만 한다.
export function notifyOnStatusChange(previous: Agent | undefined, next: Agent) {
  if (!previous || previous.status === next.status) return;
  const native = window.agentNavNative;
  if (next.status === "waiting") announce(S.announceNeedsInput(clampTitle(next.title, ANNOUNCE_TITLE_MAX)), true);
  else if (next.status === "idle" && (previous.status === "running" || previous.status === "waiting")) announce(S.announceFinished(clampTitle(next.title, ANNOUNCE_TITLE_MAX)));
  if (previous.status === "waiting") void native?.clearNotification?.(next.id);
  if (next.status === "waiting") {
    if (native?.notify) setTimeout(() => void notifyApproval(next.id), APPROVAL_DELAY_MS);
  } else if (next.status === "idle" && (previous.status === "running" || previous.status === "waiting")) {
    setTimeout(() => void notifyResponse(next.id), RESPONSE_DELAY_MS);
  }
}

// 알림과 토스트에 들어가는 세션 제목. 세션 제목이 길어도(옛 세션은 첫 요청 전체) 알림 제목이 한 줄 안에 들어가게 줄인다.
const NOTIFICATION_TITLE_MAX = 48;
const ANNOUNCE_TITLE_MAX = 80;

// 창이 포커스이면 메인이 OS 알림을 띄우지 않고 false 를 돌려준다. 그때 보고 있지 않은 세션이 끝났으면 앱 안 토스트로 대신 알린다(승인 대기는 제목줄의 AttentionChip 이 맡는다).
async function notifyResponse(agentId: string) {
  const agent = getState().agents.find((a) => a.id === agentId);
  if (!agent || agent.status !== "idle" || getState().settings?.notifyOnResponse === false) return;
  // 본문은 마지막 답의 앞부분이다. 화면에 안 열린 세션은 타임라인이 없어서 데몬에서 읽는다(승인 알림과 같다).
  // 제목은 세션 제목만 쓴다. "Session:" 표시는 사람의 입력이 필요한 알림(질문, 승인)에만 붙인다. 남는 글이 없으면 본문은 비운다.
  const items = getState().timelines[agentId] ?? (await rpc.call("agents.timeline", { agentId }).catch(() => []));
  const last = items.findLast((i) => i.kind === "assistant");
  const body = (last?.kind === "assistant" ? notificationPreview(last.text) : null) ?? "";
  const shown = await window.agentNavNative?.notify?.({ agentId, kind: "response", title: S.notificationFinishedTitle(clampTitle(agent.title, NOTIFICATION_TITLE_MAX)), body }).catch(() => false);
  if (shown === true || agent.feedbackId) return;
  const { panes, centerView } = getState();
  if (isSessionShown(agentId, panes, centerView)) return;
  notify({
    key: `finished:${agentId}`,
    message: S.finishedToast(clampTitle(agent.title, NOTIFICATION_TITLE_MAX)),
    actions: [{ label: S.notificationOpenSession, run: () => handleNotificationAction({ agentId, action: "open" }), primary: true }],
  });
}

async function notifyApproval(agentId: string) {
  const agent = getState().agents.find((a) => a.id === agentId);
  if (agent?.status !== "waiting" || getState().settings?.notifyOnApproval === false) return;
  const items = getState().timelines[agentId] ?? (await rpc.call("agents.timeline", { agentId }).catch(() => []));
  const pending = items.find((i): i is PermissionItem => i.kind === "permission" && i.status === "pending");
  if (!pending || getState().agents.find((a) => a.id === agentId)?.status !== "waiting") return;
  // fixB: 질문과 계획 승인은 알림의 Allow 로 답할 수 없어 세션을 여는 버튼만 둔다. 그 밖의 승인은 Allow Once 다(카드의 주 단추, 사이드바와 같은 범위).
  const asks = needsReview(pending.toolName);
  const command = typeof pending.input.command === "string" ? pending.input.command.split("\n")[0].slice(0, 200) : null;
  void window.agentNavNative?.notify?.({
    agentId,
    kind: "approval",
    title: S.notificationTitle(clampTitle(agent.title, NOTIFICATION_TITLE_MAX)),
    body: pending.toolName === QUESTION_TOOL ? S.notificationQuestions : pending.toolName === PLAN_TOOL ? S.notificationPlan : isNotionProposeTool(pending.toolName) ? S.notificationNotion : (command ?? S.notificationApproval),
    ...(asks ? {} : { itemId: pending.id }),
    actionLabel: asks ? S.notificationOpenSession : S.notificationAllow,
  });
}

// 알림이나 알림 버튼을 눌렀다. 메인이 창을 앞으로 가져온 뒤(Allow 는 가져오지 않는다) 이 이벤트로 알려 준다.
export function handleNotificationAction({ agentId, action, itemId }: NotificationAction) {
  if (!getState().agents.some((a) => a.id === agentId)) return;
  if (action === "allow" && itemId) {
    void rpc.call("agents.respondPermission", { agentId, itemId, decision: "allow" }).catch(() => undefined);
    return;
  }
  const shown = getState().panes.find((p) => p.kind === "agent" && p.agentId === agentId);
  if (shown) focusPane(shown.id);
  else openAgent(agentId);
  setState({ focusComposer: { paneId: getState().activePaneId, nonce: Date.now() } });
}
