import { relative } from "node:path";
import { defaultChangeScope, type ServerEvent } from "../shared/protocol";
import type { FeedbackRunner } from "./feedback";
import { resolveInside, resolveReadable, writeWorkspaceFile } from "./files";
import * as gitOps from "./git";
import { blameOf } from "./gitBlame";
import { lastTurnOriginal } from "./lastTurn";
import type { SessionChanges } from "./sessionChanges";
import { checkUndo, forgetTouched, touchedOriginal } from "./sessionTouch";
import { usesSnapshots } from "./snapshots";
import type { Store } from "./store";
import { T } from "./strings";
import { createPullRequest, mergeInfo, mergeIntoBase, unmergedCount } from "./worktreeFlow";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type GitHandlerDeps = { store: Store; feedback: FeedbackRunner; broadcast: (event: ServerEvent) => void; sessionChanges: SessionChanges };

export function gitHandlers(deps: GitHandlerDeps): HandlersFor<MethodsIn<"git"> | MethodsIn<"changes"> | MethodsIn<"worktree"> | "files.write" | "agents.worktreeStatus"> {
  const { store, feedback, broadcast } = deps;
  const { agentsSharingRepo, baseOf, changeSetHas, changesOf, infoOf, listsFromLedger, scopedBase } = deps.sessionChanges;
  return {
    // 그 세션의 변경 집합(git 기준 커밋 대비)에 든 파일이나 유지 기록이 있는 파일만, 세션 cwd 안에서만 쓴다.
    // 기준 커밋이 없는 레포(커밋 0개)는 모든 파일이 untracked 라 변경 집합이 곧 전체 파일이므로, 그때는 유지 기록만 인정한다.
    "files.write": async ({ agentId, path, text }) => {
      const agent = store.agent(agentId);
      const absolute = resolveInside(agent.cwd, path);
      if (!(await changeSetHas(agent, absolute))) throw new Error(T.errNotChangedFile);
      await writeWorkspaceFile(agent.cwd, absolute, text);
      return null;
    },
    "agents.worktreeStatus": async ({ agentId }) => {
      const agent = store.agent(agentId);
      if (!agent.worktree) return null;
      return { ...(await gitOps.worktreeStatus(agent.worktree.root)), unmerged: await unmergedCount(agent.worktree), branch: agent.worktree.branch, base: agent.worktree.base };
    },
    "worktree.mergeInfo": async ({ agentId }) => {
      const { worktree } = store.agent(agentId);
      return worktree ? mergeInfo(worktree) : null;
    },
    "worktree.merge": async ({ agentId, confirmed }) => {
      if (confirmed !== true) throw new Error(T.errNotConfirmed);
      const { worktree } = store.agent(agentId);
      if (!worktree) throw new Error(T.errNotWorktreeSession);
      const merged = await mergeIntoBase(worktree);
      // 합친 작업 트리를 쓰는 세션들의 변경 목록이 바뀐다
      const affected = merged.dir ? (await agentsSharingRepo(merged.dir)).map((a) => a.id) : [];
      return { target: merged.target, fastForward: merged.fastForward, commits: merged.commits, affectedAgentIds: affected };
    },
    "worktree.createPr": async ({ agentId, confirmed }) => {
      if (confirmed !== true) throw new Error(T.errNotConfirmed);
      const { worktree } = store.agent(agentId);
      if (!worktree) throw new Error(T.errNotWorktreeSession);
      return createPullRequest(worktree);
    },
    "changes.list": ({ agentId }) => store.changes(agentId),
    "changes.setOriginal": ({ agentId, path, original }) => {
      broadcast({ type: "changes", agentId, changes: store.setChange(agentId, path, original) });
      return null;
    },
    "changes.clear": ({ agentId, path }) => {
      broadcast({ type: "changes", agentId, changes: store.clearChanges(agentId, path) });
      return null;
    },
    // FIX4A: Undo. 서버가 장부로 "에이전트의 마지막 쓰기 뒤 아무도 안 고친 파일" 만 허용한다(화면의 확인 창은 checkUndo 결과로 파일 이름을 보인다).
    "changes.checkUndo": ({ agentId, paths }) => {
      const agent = store.agent(agentId);
      return checkUndo(agent, store, paths.map((path) => resolveInside(agent.cwd, path)));
    },
    "changes.undo": async ({ agentId, items }) => {
      const agent = store.agent(agentId);
      const texts = new Map(items.map((item) => [resolveInside(agent.cwd, item.path), item.text]));
      const check = await checkUndo(agent, store, [...texts.keys()]);
      for (const path of check.allowed) if (!(await changeSetHas(agent, path))) throw new Error(T.errNotChangedFile);
      for (const path of check.allowed) await writeWorkspaceFile(agent.cwd, path, texts.get(path) ?? null);
      await forgetTouched(agent, store, check.allowed);
      for (const path of check.allowed) broadcast({ type: "changes", agentId, changes: store.clearChanges(agentId, path) });
      return { ...check, reverted: check.allowed };
    },
    "git.info": ({ agentId }) => infoOf(store.agent(agentId)),
    // fetch, push, pull 은 사용자가 버튼을 눌렀을 때만 온다. 강제 옵션은 없다.
    "git.fetch": async ({ agentId }) => {
      const agent = store.agent(agentId);
      await gitOps.fetch(agent.cwd);
      return infoOf(agent);
    },
    "git.push": async ({ agentId }) => ({ output: await gitOps.push(store.agent(agentId).cwd) }),
    "git.pull": async ({ agentId }) => ({ output: await gitOps.pull(store.agent(agentId).cwd) }),
    "git.changes": ({ agentId, scope, includeOutside }) => changesOf(store.agent(agentId), scope, includeOutside === true),
    "git.workspaceChanges": async ({ workspaceId }) => {
      const dir = store.workspace(workspaceId).dir;
      const result = gitOps.limitToFolder(dir, await gitOps.changes(dir, (await gitOps.headCommit(dir)) ? "HEAD" : null), false);
      return { files: result.files };
    },
    "git.original": async ({ agentId, path, scope, from }) => {
      const agent = store.agent(agentId);
      if (agent.feedbackId) return { text: await feedback.original(agent.feedbackId, relative(agent.cwd, resolveInside(agent.cwd, path))) };
      const absolute = await resolveReadable(agent.cwd, path);
      // 이름이 바뀐 파일(R)의 기준 내용은 옛 이름으로 읽는다
      const source = from ? await resolveReadable(agent.cwd, from) : absolute;
      const resolved = scope ?? defaultChangeScope(agent);
      if (resolved === "lastTurn") return { text: await lastTurnOriginal(agent, store, absolute) };
      if (await listsFromLedger(agent, resolved)) {
        const before = await touchedOriginal(agent, store, absolute);
        if (before !== undefined) return { text: before };
      }
      const scoped = await scopedBase(agent, resolved);
      if (scoped) return { text: await gitOps.original(agent.cwd, scoped, source, { strict: true }) };
      const base = (await baseOf(agent))?.ref ?? null;
      if (!base && usesSnapshots(agent)) return { text: store.change(agentId, absolute)?.original ?? null };
      return { text: await gitOps.original(agent.cwd, base, source, { strict: true }) };
    },
    "git.blame": async ({ workspaceId, path, text }) => ({ blame: await blameOf(store.workspace(workspaceId).dir, String(path), typeof text === "string" ? text : undefined) }),
    "git.checkBranchName": async ({ workspaceId, branch }) => {
      const root = await gitOps.repoRoot(store.workspace(workspaceId).dir);
      return { problem: root ? await gitOps.branchNameProblem(root, branch) : T.errNotGitRepoForWorktree };
    },
    "git.branches": ({ workspaceId }) => gitOps.branches(store.workspace(workspaceId).dir),
    "git.switchBranch": async ({ workspaceId, branch, allowBusy }) => {
      const dir = store.workspace(workspaceId).dir;
      const sharing = await agentsSharingRepo(dir);
      const busy = sharing.filter((a) => a.status === "running" || a.status === "waiting");
      if (busy.length > 0 && !allowBusy) return { switched: false, busy: busy.map((a) => a.title), affectedAgentIds: [], info: await gitOps.branches(dir) };
      await gitOps.switchBranch(dir, branch);
      return { switched: true, busy: [], affectedAgentIds: sharing.map((a) => a.id), info: await gitOps.branches(dir) };
    },
    "git.prs": ({ agentId }) => gitOps.pullRequests(store.agent(agentId).cwd),
  };
}
