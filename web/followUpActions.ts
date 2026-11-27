import { FOLLOW_UP_LIMITS, isTracked, type FollowUpItem, type FollowUpsState, type SnoozeChoice } from "../shared/followups";
import { clampTitle } from "../shared/sessionTitle";
import { notify } from "./notices";
import { rpc } from "./rpc";
import { assistantShown, followUpsShown } from "./screenVisibility";
import { flash, getState, openAgent, openAssistant, setState } from "./store";
import { S } from "./strings";

const F = S.followUp;
const NOTIFICATION_TITLE_MAX = 48;

const fail = (error: unknown) => flash(F.failed(error instanceof Error ? error.message : String(error)));
const receive = (followUps: FollowUpsState) => setState({ followUps });

export function receiveFollowUps(next: FollowUpsState) {
  const previous = getState().followUps;
  setState({ followUps: next });
  const nudge = next.nudge;
  if (!previous || !nudge || nudge.id === previous.nudge?.id) return;
  if (Date.now() - Date.parse(nudge.at) > FOLLOW_UP_LIMITS.nudgeFreshMs) return;
  if (!followUpsShown(getState().settings)) return;
  if (assistantShown(getState().settings) && getState().assistant?.agentId) return;
  void remindOf(next, nudge.itemIds);
}

async function remindOf(state: FollowUpsState, itemIds: string[]) {
  const agents = getState().agents;
  const due = state.items.filter((item) => itemIds.includes(item.id) && agents.some((a) => a.id === item.agentId && isTracked(a)));
  if (due.length === 0) return;
  const first = due[0];
  const session = clampTitle(agents.find((a) => a.id === first.agentId)?.title ?? "", NOTIFICATION_TITLE_MAX);
  const title = due.length === 1 ? F.remindTitle : F.remindTitleMany(due.length);
  const body = due.length === 1 ? F.remindBody(itemText(first), session) : F.remindBodyMany(itemText(first), due.length - 1);
  const shown = await window.agentNavNative?.notify?.({ agentId: first.agentId, kind: "reminder", title, body, actionLabel: S.notificationOpenSession }).catch(() => false);
  if (shown === true) return;
  if (getState().centerView === "mate" && document.visibilityState === "visible") return;
  notify({ key: "follow-ups", message: due.length === 1 ? F.remindToast(itemText(first)) : F.remindTitleMany(due.length), actions: [{ label: F.show, primary: true, run: openAssistant }] });
}

export const itemText = (item: Pick<FollowUpItem, "kind" | "text">) => item.text || F.kindFallback[item.kind];

export function checkFollowUps() {
  const state = getState().followUps;
  if (!state || state.checking) return;
  setState({ followUps: { ...state, checking: true, error: null } });
  void rpc.call("followUps.check", {}).then(receive).catch((error) => {
    const latest = getState().followUps;
    if (latest) setState({ followUps: { ...latest, checking: false } });
    fail(error);
  });
}

export function snoozeFollowUp(id: string, choice: SnoozeChoice) {
  void rpc.call("followUps.snooze", { id, choice }).then(receive).catch(fail);
}

export function wakeFollowUp(id: string) {
  void rpc.call("followUps.wake", { id }).then(receive).catch(fail);
}

export function dismissFollowUp(id: string) {
  void rpc.call("followUps.dismiss", { id }).then(receive).catch(fail);
}

export function keepSessionOpen(agentId: string) {
  void rpc.call("followUps.keepOpen", { agentId }).then(receive).catch(fail);
}

export function markSessionsDone(agentIds: string[]) {
  for (const agentId of agentIds) void rpc.call("agents.setDone", { agentId, done: true }).catch(fail);
}

export async function replyToFollowUp(item: FollowUpItem, text: string): Promise<boolean> {
  const prompt = text.trim();
  if (!prompt) return false;
  try {
    receive(await rpc.call("followUps.reply", { id: item.id, text: prompt }));
    return true;
  } catch (error) {
    fail(error);
    return false;
  }
}

export function openFollowUpSession(agentId: string) {
  if (getState().agents.some((a) => a.id === agentId)) openAgent(agentId);
}
