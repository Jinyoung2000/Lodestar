import type { Agent, TimelineItem } from "../shared/protocol";
import { currentSelection } from "./Editor";
import { attachmentKey, getDraft, setDraft } from "./composerState";
import { fileRefText, inlineFileRefs, insertFileRef } from "./composerFileRefs";
import { chatPaneWorkspace } from "./editorChat";
import { rpc } from "./rpc";
import { addAttachment, attachmentsOf, flash, getState, revealChat, updateAttachment } from "./store";
import { S } from "./strings";

export function attachFile(paneId: string, workspaceId: string, path: string) {
  addAttachment(paneId, selectionOf(workspaceId, path) ?? { workspaceId, path, startLine: null, endLine: null, text: null });
}

export function selectionOf(workspaceId: string, path: string) {
  const selection = currentSelection();
  return selection && selection.workspaceId === workspaceId && selection.path === path && selection.startLine != null ? selection : null;
}

export function attachEditorSelection(paneId: string, selection: NonNullable<ReturnType<typeof currentSelection>>) {
  const state = getState();
  const pane = state.panes.find((item) => item.id === paneId);
  const key = attachmentKey(state.panes, paneId);
  const workspace = state.workspaces.find((item) => item.id === selection.workspaceId);
  const path = workspace && selection.workspaceId !== chatPaneWorkspace(pane, state.agents) && !selection.path.startsWith("/") ? `${workspace.dir}/${selection.path}` : selection.path;
  const inlineRef = fileRefText(path, selection.startLine, selection.endLine);
  const text = getDraft(key);
  const current = attachmentsOf(state, paneId);
  const ranges = inlineFileRefs(text, [...current.flatMap((attachment) => attachment.inlineRef ? [attachment.inlineRef] : []), inlineRef]);
  const existing = ranges.find((range) => range.value === inlineRef);
  const input = document.getElementById(`composer-${paneId}`) as HTMLTextAreaElement | null;
  const start = input?.value === text ? input.selectionStart : text.length;
  const end = input?.value === text ? input.selectionEnd : text.length;
  const from = ranges.find((range) => range.from < start && start < range.to)?.from ?? start;
  const to = ranges.find((range) => range.from < end && end < range.to)?.to ?? end;
  const edit = insertFileRef(text, start === end ? to : from, to, inlineRef);
  revealChat();
  const id = addAttachment(paneId, { ...selection, path, inlineRef });
  if (current.some((attachment) => attachment.id === id)) updateAttachment(paneId, id, { text: selection.text });
  const focus = (element: HTMLTextAreaElement, position: number) => {
    element.focus();
    element.setSelectionRange(position, position);
  };
  if (!existing && input?.isConnected && input.value === text && input.getClientRects().length) {
    input.focus();
    input.setSelectionRange(edit.from, edit.to);
    if (document.execCommand("insertText", false, edit.insert)) {
      focus(input, edit.selStart);
      return;
    }
  }
  if (!existing) setDraft(key, text.slice(0, edit.from) + edit.insert + text.slice(edit.to));
  const value = getDraft(key);
  requestAnimationFrame(() => {
    const element = document.getElementById(`composer-${paneId}`) as HTMLTextAreaElement | null;
    if (getState().activePaneId === paneId && element?.value === value) focus(element, existing?.to ?? edit.selStart);
  });
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
