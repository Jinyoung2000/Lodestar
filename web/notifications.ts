import { isSilentReply } from "../shared/assistant";
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
  kind: "response" | "approval" | "reminder";
  title: string;
  body: string;
  itemId?: string;
  actionLabel?: string;
};

export type NotificationAction = { agentId: string; action: "open" | "allow"; itemId?: string };

const APPROVAL_DELAY_MS = 250;
const RESPONSE_DELAY_MS = 500;

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

const NOTIFICATION_TITLE_MAX = 48;
const ANNOUNCE_TITLE_MAX = 80;

async function notifyResponse(agentId: string) {
  const agent = getState().agents.find((a) => a.id === agentId);
  if (!agent || agent.status !== "idle" || agent.automationId || getState().settings?.notifyOnResponse === false) return;
  const items = getState().timelines[agentId] ?? (await rpc.call("agents.timeline", { agentId }).catch(() => []));
  const last = items.findLast((i) => i.kind === "assistant");
  if (agent.assistant && (last?.kind !== "assistant" || isSilentReply(last.text))) return;
  const body = (last?.kind === "assistant" ? notificationPreview(last.text) : null) ?? "";
  const title = agent.assistant ? agent.title : S.notificationFinishedTitle(clampTitle(agent.title, NOTIFICATION_TITLE_MAX));
  const shown = await window.agentNavNative?.notify?.({ agentId, kind: "response", title, body }).catch(() => false);
  if (shown === true || agent.feedbackId) return;
  const { panes, centerView } = getState();
  if (isSessionShown(agentId, panes, centerView)) return;
  notify({
    key: `finished:${agentId}`,
    message: agent.assistant ? S.assistant.toast(agent.title, body) : S.finishedToast(clampTitle(agent.title, NOTIFICATION_TITLE_MAX)),
    actions: [{ label: S.notificationOpenSession, run: () => openFromToast(agentId), primary: true }],
  });
}

function openFromToast(agentId: string) {
  const native = window.agentNavNative;
  if (native?.openNotificationSession) void native.openNotificationSession(agentId).catch(() => undefined);
  else handleNotificationAction({ agentId, action: "open" });
}

export function openNotificationSession(agentId: string): boolean {
  handleNotificationAction({ agentId, action: "open" });
  return true;
}

async function notifyApproval(agentId: string) {
  const agent = getState().agents.find((a) => a.id === agentId);
  if (agent?.status !== "waiting" || getState().settings?.notifyOnApproval === false) return;
  const items = getState().timelines[agentId] ?? (await rpc.call("agents.timeline", { agentId }).catch(() => []));
  const pending = items.find((i): i is PermissionItem => i.kind === "permission" && i.status === "pending");
  if (!pending || getState().agents.find((a) => a.id === agentId)?.status !== "waiting") return;
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
