import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { WebSocket } from "ws";
import type { ServerEvent } from "../shared/protocol";
import { worktreeParentDir } from "../shared/openPath"; // OPENFOLDER
import type { AgentRunner } from "./agents";
import { openFolderInVSCode } from "./files";
import type { ReviewCheckouts } from "./folderTrust";
import * as gitOps from "./git";
import { realDir } from "./paths";
import { busyAgents } from "./removedFolders";
import { revealInFileManager } from "./reveal";
import type { Store } from "./store";
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

const expandHome = (dir: string) => resolve(dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));

function requireFolder(absolute: string) {
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(T.errFolderNotFound(absolute));
  return absolute;
}

export function workspaceHandlers(deps: WorkspaceHandlerDeps): HandlersFor<MethodsIn<"workspaces"> | MethodsIn<"sessionOrder">> {
  const { store, runner, broadcast, reviewCheckouts, workspaceWatch, pruneBoard } = deps;
  const announceWorkspaces = () => broadcast({ type: "workspaces", workspaces: store.workspaces });
  return {
    "workspaces.list": () => store.workspaces,
    // SESSIONORDER: 사이드바 세션 순서. 바꾸면 모든 화면(다른 창 포함)에 새 목록을 보낸다. 모바일 허용 목록에는 없다.
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
      // 사용자가 직접 추가한 폴더는 PR 리뷰 체크아웃이었더라도 이제 신뢰한다
      reviewCheckouts.forget(workspace.dir);
      announceWorkspaces();
      return workspace;
    },
    "workspaces.open": async ({ dir }) => {
      const absolute = requireFolder(realDir(expandHome(dir)));
      let workspace = store.workspaces.find((w) => w.dir === absolute);
      if (!workspace) {
        const tree = await detectWorktree(absolute);
        if (tree) {
          const parent = store.addWorkspace(worktreeParentDir(absolute, tree));
          workspace = store.addWorkspace(absolute, parent.id, `${parent.name} (${tree.branch})`);
        } else workspace = store.addWorkspace(absolute);
      }
      reviewCheckouts.forget(workspace.dir);
      announceWorkspaces();
      return workspace;
    },
    // fix5-3: 사라진 폴더를 새 경로에 다시 잇는다. 폴더를 지금 쓰는 세션이 돌고 있으면 그 작업 폴더가 바뀌므로 거절한다.
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
    // WSMENU: 세션은 지우지 않고 숨긴다. 열려 있던 화면은 agentRemoved 로 그 세션 칸을 비우고, 폴더를 다시 추가하면 store.onRestored 가 돌려준다.
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
