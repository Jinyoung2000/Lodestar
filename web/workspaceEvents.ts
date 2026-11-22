export const WORKSPACE_CHANGED_EVENT = "agent-nav:workspace-changed";

export function announceWorkspaceChanged(workspaceIds: string[]) {
  window.dispatchEvent(new CustomEvent(WORKSPACE_CHANGED_EVENT, { detail: { workspaceIds } }));
}

export function onWorkspaceChanged(workspaceId: string | null, run: () => void): () => void {
  if (!workspaceId) return () => undefined;
  const listener = (event: Event) => {
    if ((event as CustomEvent<{ workspaceIds: string[] }>).detail.workspaceIds.includes(workspaceId)) run();
  };
  window.addEventListener(WORKSPACE_CHANGED_EVENT, listener);
  return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, listener);
}
