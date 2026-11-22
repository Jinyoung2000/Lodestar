import type { Agent, TimelineItem } from "../shared/protocol";
import { currentSelection } from "./Editor";
import { attachmentKey } from "./composerState";
import { rpc } from "./rpc";
import { addAttachment, flash, getState } from "./store";
import { S } from "./strings";

export function attachFile(paneId: string, workspaceId: string, path: string) {
  addAttachment(paneId, selectionOf(workspaceId, path) ?? { workspaceId, path, startLine: null, endLine: null, text: null });
}

export function selectionOf(workspaceId: string, path: string) {
  const selection = currentSelection();
  return selection && selection.workspaceId === workspaceId && selection.path === path && selection.startLine != null ? selection : null;
}

export async function attachSession(paneId: string, workspaceId: string | null, session: Agent) {
  const state = getState();
  const key = attachmentKey(state.panes, paneId);
  const fromPane = state.panes.some((pane) => pane.id === paneId);
  try {
    const items = state.timelines[session.id] ?? (await rpc.call("agents.timeline", { agentId: session.id }));
    const { panes } = getState();
    if (attachmentKey(panes, paneId) !== key || (fromPane && !panes.some((pane) => pane.id === paneId))) return;
    addAttachment(paneId, { workspaceId, path: session.id, startLine: null, endLine: null, text: sessionSummary(items), session: { title: session.title } });
  } catch {
    flash(S.attachSessionFailed);
  }
}

const SUMMARY_MESSAGES = 8;
const SUMMARY_CHARS = 6000;

export function sessionSummary(items: TimelineItem[]) {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === "user" && item.source !== "system") lines.push(`User: ${item.shown ?? item.text}`);
    else if (item.kind === "assistant" && !item.streaming) lines.push(`Assistant: ${item.text}`);
  }
  const text = lines.slice(-SUMMARY_MESSAGES).join("\n\n");
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}\n...` : text;
}
