import type { RpcMethods, Workspace } from "../shared/protocol";
import type { ScmTarget } from "../shared/scm";
import { realDir } from "./paths";
import * as scm from "./scm";
import { generateCommitMessage } from "./scmMessage";

type ScmMethod = Extract<keyof RpcMethods, `scm.${string}`>;
type Handlers = { [M in ScmMethod]: (params: RpcMethods[M]["params"]) => Promise<RpcMethods[M]["result"]> | RpcMethods[M]["result"] };

export type ScmDeps = {
  agentDir: (agentId: string) => string;
  workspaceDir: (workspaceId: string) => string;
  workspaces: () => Workspace[];
  addWorkspace: (dir: string, parentId: string | null, name: string) => Workspace;
  announce: () => void;
};

export function scmHandlers(deps: ScmDeps): Handlers {
  const dirOf = (target: ScmTarget) => {
    if (target.agentId) return deps.agentDir(target.agentId);
    if (target.workspaceId) return deps.workspaceDir(target.workspaceId);
    throw new Error("Choose a session or a folder.");
  };
  const listed = () => deps.workspaces().filter((w) => !w.feedback);
  return {
    "scm.status": ({ agentId, workspaceId }) => scm.status(dirOf({ agentId, workspaceId })),
    "scm.stage": ({ agentId, workspaceId, paths }) => serial(dirOf({ agentId, workspaceId }), async (dir) => void (await scm.stage(dir, paths))).then(() => null),
    "scm.unstage": ({ agentId, workspaceId, paths }) => serial(dirOf({ agentId, workspaceId }), async (dir) => void (await scm.unstage(dir, paths))).then(() => null),
    "scm.discard": ({ agentId, workspaceId, paths }) => serial(dirOf({ agentId, workspaceId }), (dir) => scm.discard(dir, paths)),
    "scm.commit": ({ agentId, workspaceId, options }) => serial(dirOf({ agentId, workspaceId }), (dir) => scm.commit(dir, options)),
    "scm.undoCommit": ({ agentId, workspaceId }) => serial(dirOf({ agentId, workspaceId }), (dir) => scm.undoLastCommit(dir)),
    "scm.generateMessage": async ({ agentId, workspaceId, model }) => ({ message: await generateCommitMessage(dirOf({ agentId, workspaceId }), model) }),
    "scm.graph": ({ agentId, workspaceId, limit }) => scm.graph(dirOf({ agentId, workspaceId }), limit),
    "scm.commitFiles": ({ agentId, workspaceId, hash }) => scm.commitFiles(dirOf({ agentId, workspaceId }), hash),
    "scm.commitDiff": ({ agentId, workspaceId, hash, rel, from }) => scm.commitFileDiff(dirOf({ agentId, workspaceId }), hash, rel, from),
    "scm.worktrees": () =>
      scm.worktrees(
        listed()
          .filter((w) => !w.parentId)
          .map((w) => w.dir),
      ),
    "scm.pull": ({ agentId, workspaceId, mode }) => serial(dirOf({ agentId, workspaceId }), (dir) => scm.pullOp(dir, mode === "merge" || mode === "rebase" ? mode : "ff")),
    "scm.push": ({ agentId, workspaceId }) => serial(dirOf({ agentId, workspaceId }), (dir) => scm.pushOp(dir)),
    "scm.fetch": ({ agentId, workspaceId }) => serial(dirOf({ agentId, workspaceId }), (dir) => scm.fetchOp(dir)),
    "scm.continue": ({ agentId, workspaceId, message }) => serial(dirOf({ agentId, workspaceId }), (dir) => scm.continueOperation(dir, typeof message === "string" ? message : "")),
    "scm.abort": ({ agentId, workspaceId }) => serial(dirOf({ agentId, workspaceId }), async (dir) => void (await scm.abortOperation(dir))).then(() => null),
    "scm.fileDiff": ({ agentId, workspaceId, rel, section }) =>
      scm.fileDiff(dirOf({ agentId, workspaceId }), String(rel), section === "staged" || section === "uncommitted" ? section : "changes"),
    "scm.stageHunk": ({ agentId, workspaceId, rel, section, index, hash }) =>
      serial(dirOf({ agentId, workspaceId }), (dir) => scm.stageHunk(dir, String(rel), section === "staged" ? "staged" : "changes", Number(index), String(hash))).then(() => null),
    "scm.discardHunk": ({ agentId, workspaceId, rel, index, hash }) => serial(dirOf({ agentId, workspaceId }), (dir) => scm.discardHunk(dir, String(rel), Number(index), String(hash))).then(() => null),
    "scm.openWorktree": async ({ path }) => {
      const repos = await scm.worktrees(listed().map((w) => w.dir));
      const found = repos.flatMap((r) => r.worktrees.map((w) => ({ repo: r, worktree: w }))).find((x) => x.worktree.path === realDir(path));
      if (!found) throw new Error(`Not a worktree of a workspace folder: ${path}`);
      const existing = deps.workspaces().find((w) => w.dir === found.worktree.path);
      if (existing) return { workspaceId: existing.id };
      const parent = listed().find((w) => w.dir === found.repo.root);
      const workspace = deps.addWorkspace(found.worktree.path, parent?.id ?? null, `${found.repo.name} (${found.worktree.branch ?? found.worktree.head})`);
      deps.announce();
      return { workspaceId: workspace.id };
    },
  };
}

const queues = new Map<string, Promise<unknown>>();

function serial<T>(dir: string, job: (dir: string) => Promise<T>): Promise<T> {
  const key = realDir(dir);
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => job(dir));
  queues.set(key, run);
  void run.finally(() => queues.get(key) === run && queues.delete(key)).catch(() => undefined);
  return run;
}
