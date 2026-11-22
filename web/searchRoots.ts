import type { RpcMethods } from "../shared/protocol";
import { isMultiRoot, sessionRoots } from "./sessionFolders";
import type { FileResult } from "./searchTree";
import { getState, searchWorkspaceOf, type State } from "./store";

export type SearchRootRef = { label: string; workspaceId: string };
type Result = RpcMethods["files.search"]["result"];

export function activeSearchRoots(s: Pick<State, "panes" | "activePaneId" | "agents" | "workspaces">): SearchRootRef[] | null {
  const pane = s.panes.find((p) => p.id === s.activePaneId);
  const agent = pane?.kind === "agent" ? s.agents.find((a) => a.id === pane.agentId) : undefined;
  if (!agent || !isMultiRoot(agent)) return null;
  return sessionRoots(agent, s.workspaces).flatMap((r) => (r.workspace ? [{ label: r.label, workspaceId: r.id }] : []));
}

export function splitRootPath(path: string, roots: readonly SearchRootRef[]): { root: SearchRootRef; rel: string } | null {
  const cut = path.indexOf("/");
  const label = cut === -1 ? path : path.slice(0, cut);
  const root = roots.find((r) => r.label === label);
  return root ? { root, rel: cut === -1 ? "" : path.slice(cut + 1) } : null;
}

export function searchTargetOf(path: string): { workspaceId: string; path: string } | null {
  const s = getState();
  const run = s.searchRun;
  if (run.kind === "done" && run.roots) {
    const split = splitRootPath(path, run.roots);
    return split ? { workspaceId: split.root.workspaceId, path: split.rel } : null;
  }
  const workspaceId = searchWorkspaceOf(s);
  return workspaceId ? { workspaceId, path } : null;
}

export function mergeRootResults(parts: readonly { root: SearchRootRef; result: Result }[]): Result {
  return {
    files: parts.flatMap(({ root, result }) => result.files.map((file) => ({ ...file, path: `${root.label}/${file.path}` }))),
    matches: parts.reduce((sum, { result }) => sum + result.matches, 0),
    truncated: parts.some(({ result }) => result.truncated),
    engine: parts[0]?.result.engine ?? "rg",
  };
}

export function withRootDirs(files: FileResult[]): FileResult[] {
  return files.map((file) => {
    const cut = file.dir.indexOf("/");
    return { ...file, dir: cut === -1 ? "" : file.dir.slice(cut + 1) };
  });
}
