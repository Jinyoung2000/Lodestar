import type { Agent } from "../shared/protocol";

export function resolveInWorkspace(workspaceDir: string, path: string) {
  if (path.startsWith("/")) return path;
  const parts = workspaceDir.split("/");
  for (const segment of path.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

export function foreignFolder(workspaceDir: string | undefined, path: string | null, agent: Pick<Agent, "cwd" | "workspaceId"> | undefined, repoRoot: string | null | undefined): { folder: string; file: string; session: string } | null {
  if (!workspaceDir || path === null || !agent || agent.workspaceId === null) return null;
  const session = repoRoot ?? agent.cwd;
  const file = resolveInWorkspace(workspaceDir, path);
  if (file === session || file.startsWith(`${session}/`) || file.startsWith(`${agent.cwd}/`)) return null;
  return { folder: workspaceDir, file, session: agent.cwd };
}
