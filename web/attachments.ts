import type { Agent, TimelineItem } from "../shared/protocol";
import { currentSelection } from "./Editor";
import { rpc } from "./rpc";
import { addAttachment, flash, getState } from "./store";
import { S } from "./strings";

// 입력창 첨부(B3-10, B3-11). 파일을 첨부할 때 그 파일에 선택 영역이 있으면 항상 경로와 줄 범위, 선택한 글을 함께 넣는다(버그 7).
export function attachFile(paneId: string, workspaceId: string, path: string) {
  addAttachment(paneId, selectionOf(workspaceId, path) ?? { workspaceId, path, startLine: null, endLine: null, text: null });
}

// 활성 에디터에서 그 파일의 줄 범위를 고른 상태면 그 선택(경로, 줄 범위, 글). 아니면 null.
export function selectionOf(workspaceId: string, path: string) {
  const selection = currentSelection();
  return selection && selection.workspaceId === workspaceId && selection.path === path && selection.startLine != null ? selection : null;
}

// 다른 세션의 요약을 첨부한다. 요약은 그 세션 대화의 최근 몇 개 메시지다.
export async function attachSession(paneId: string, workspaceId: string | null, session: Agent) {
  try {
    const items = getState().timelines[session.id] ?? (await rpc.call("agents.timeline", { agentId: session.id }));
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
