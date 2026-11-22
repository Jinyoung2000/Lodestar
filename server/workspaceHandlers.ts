import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { WebSocket } from "ws";
import type { ServerEvent } from "../shared/protocol";
import { worktreeParentDir } from "../shared/openPath";
import type { AgentRunner } from "./agents";
import { openFolderInVSCode } from "./files";
import type { ReviewCheckouts } from "./folderTrust";
import * as gitOps from "./git";
import { realDir, realPathLoose } from "./paths";
import { busyAgents } from "./removedFolders";
import { revealInFileManager } from "./reveal";
import { HOME, type Store } from "./store";
import { T } from "./strings";
import { detectWorktree } from "./vscodeImport";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type WorkspaceHandlerDeps = {
  store: Store;
  runner: AgentRunner;
  broadcast: (event: ServerEvent) => void;
  reviewCheckouts: ReviewCheckouts;
  workspaceWatch: { setClient: (client: WebSocket, roots: string[], linked: Record<string, string>) => void };
  pruneBoard: () => void;
};

const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

const expandHome = (dir: string) => resolve(dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));

function requireFolder(absolute: string) {
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(T.errFolderNotFound(absolute));
  return absolute;
}

export function workspaceHandlers(deps: WorkspaceHandlerDeps): HandlersFor<MethodsIn<"workspaces"> | MethodsIn<"sessionOrder"> | "agents.moveToFolder"> {
  const { store, runner, broadcast, reviewCheckouts, workspaceWatch, pruneBoard } = deps;
  const announceWorkspaces = () => broadcast({ type: "workspaces", workspaces: store.workspaces });
  const openFolder = async (absolute: string, trust: boolean) => {
    let workspace = store.workspaces.find((w) => w.dir === absolute);
    if (!workspace) {
      const tree = await detectWorktree(absolute);
      if (tree) {
        const parent = store.addWorkspace(worktreeParentDir(absolute, tree));
        workspace = store.addWorkspace(absolute, parent.id, `${parent.name} (${tree.branch})`);
      } else workspace = store.addWorkspace(absolute);
    }
    if (trust) reviewCheckouts.forget(workspace.dir);
    announceWorkspaces();
    return workspace;
  };
  return {
    "workspaces.list": () => store.workspaces,
    "sessionOrder.list": () => store.sessionOrders,
    "sessionOrder.set": ({ scope, ids }) => {
      const orders = store.setSessionOrder(scope, ids);
      broadcast({ type: "sessionOrders", orders });
      return orders;
    },
    "sessionOrder.reset": ({ scopes }) => {
      const orders = store.resetSessionOrders(scopes);
      broadcast({ type: "sessionOrders", orders });
      return orders;
    },
    "workspaces.add": ({ dir }) => {
      const absolute = requireFolder(expandHome(dir));
      const workspace = store.addWorkspace(absolute);
      reviewCheckouts.forget(workspace.dir);
      announceWorkspaces();
      return workspace;
    },
    "workspaces.create": async ({ parent, name, git }) => {
      const folderName = typeof name === "string" ? name.trim() : "";
      if (!folderName || folderName.includes("/") || folderName === "." || folderName === "..") throw new Error(T.errFolderName);
      const base = expandHome(typeof parent === "string" && parent.trim() ? parent.trim() : "~/Repository");
      if (isInside(realDir(HOME), realPathLoose(base))) throw new Error(T.errMoveDataFolder);
      const wanted = resolve(base, folderName);
      if (existsSync(wanted)) throw new Error(T.errFolderExists(wanted));
      mkdirSync(wanted, { recursive: true });
      const absolute = requireFolder(realDir(wanted));
      if (git === true) await gitOps.git(absolute, ["init", "--quiet"]);
      const workspace = store.addWorkspace(absolute);
      announceWorkspaces();
      return workspace;
    },
    "agents.moveToFolder": async ({ agentId, dir, create }) => {
      const agent = store.agent(agentId);
      if (agent.workspaceId !== null) throw new Error(T.errMoveHasFolder);
      if (agent.feedbackId || agent.imported) throw new Error(T.errMoveUnsupported);
      if (typeof dir !== "string" || !dir.trim()) throw new Error(T.errFolderNotFound(String(dir)));
      const wanted = expandHome(dir.trim());
      if (isInside(realDir(HOME), realPathLoose(wanted))) throw new Error(T.errMoveDataFolder);
      if (create === true) {
        if (existsSync(wanted)) throw new Error(T.errFolderExists(wanted));
        mkdirSync(wanted, { recursive: true });
      }
      const absolute = requireFolder(realDir(wanted));
      if (isInside(realDir(HOME), absolute)) throw new Error(T.errMoveDataFolder);
      if (create === true) runner.notice(agentId, T.createdFolder(absolute.replace(/^\/private(?=\/(?:tmp|var)(?:\/|$))/, "").replace(/^\/Users\/[^/]+(?=\/|$)/, "~")));
      const workspace = await openFolder(absolute, false);
      return runner.moveToFolder(agentId, workspace.id);
    },
    "workspaces.open": async ({ dir }) => openFolder(requireFolder(realDir(expandHome(dir))), true),
    "workspaces.relocate": ({ id, dir }) => {
      const absolute = requireFolder(expandHome(String(dir).trim()));
      const running = busyAgents(store.agents.filter((a) => a.workspaceId === id && !a.worktree));
      if (running.length) throw new Error(T.errRelocateBusy(running.length));
      const { workspace, moved } = store.relocateWorkspace(id, absolute);
      for (const agent of moved) {
        runner.closeIdle(agent.id);
        broadcast({ type: "agent", agent });
      }
      announceWorkspaces();
      return workspace;
    },
    "workspaces.remove": ({ id }) => {
      const { hidden, agents } = store.removeFolderFromList(id);
      for (const agent of agents) runner.closeIdle(agent.id);
      for (const agent of agents) broadcast({ type: "agentRemoved", agentId: agent.id });
      announceWorkspaces();
      pruneBoard();
      return { hidden };
    },
    "workspaces.reveal": async ({ workspaceId }) => {
      await revealInFileManager(store.workspace(workspaceId).dir);
      return null;
    },
    "workspaces.openInVSCode": async ({ agentId, workspaceId }) => {
      const dir = agentId ? store.agent(agentId).cwd : workspaceId ? store.workspace(workspaceId).dir : null;
      if (!dir) throw new Error(T.errNoFolderToOpen);
      await openFolderInVSCode(dir);
      return null;
    },
    "workspaces.watch": async ({ workspaceIds }, client) => {
      const roots = new Set<string>();
      const linked: Record<string, string> = {};
      for (const id of Array.isArray(workspaceIds) ? workspaceIds : []) {
        const workspace = store.workspaces.find((w) => w.id === id);
        if (!workspace) continue;
        const root = realDir((await gitOps.repoRoot(workspace.dir)) ?? workspace.dir);
        roots.add(root);
        const gitDir = await gitOps.linkedGitDir(root);
        if (gitDir) linked[root] = gitDir;
      }
      workspaceWatch.setClient(client, [...roots], linked);
      return null;
    },
  };
}
