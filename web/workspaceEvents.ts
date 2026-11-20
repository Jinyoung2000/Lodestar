// FIX4A: 데몬의 파일 감시(server/workspaceWatch.ts)가 보고 있는 저장소의 바깥 변화를 알린다(workspaceChanged 이벤트). 이 이벤트를 듣는 화면은 Source Control 과 Changes 와 새 세션 화면의 Changes 다.
export const WORKSPACE_CHANGED_EVENT = "agent-nav:workspace-changed";

export function announceWorkspaceChanged(workspaceIds: string[]) {
  window.dispatchEvent(new CustomEvent(WORKSPACE_CHANGED_EVENT, { detail: { workspaceIds } }));
}

// 그 폴더가 바뀌었다는 알림을 듣는다. 돌려받은 함수로 그만 듣는다.
export function onWorkspaceChanged(workspaceId: string | null, run: () => void): () => void {
  if (!workspaceId) return () => undefined;
  const listener = (event: Event) => {
    if ((event as CustomEvent<{ workspaceIds: string[] }>).detail.workspaceIds.includes(workspaceId)) run();
  };
  window.addEventListener(WORKSPACE_CHANGED_EVENT, listener);
  return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, listener);
}
