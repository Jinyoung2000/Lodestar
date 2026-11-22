import { defaultChangeScope, type Agent, type ChangedFile, type ChangeScope, type GitInfo } from "../shared/protocol";
import type { FeedbackRunner } from "./feedback";
import * as gitOps from "./git";
import { realDir } from "./paths";
import { ensureLedger, isTouched, TOUCH_BASE, touchedChanges, touchedLastTurn } from "./sessionTouch";
import { applyKeptCounts, snapshotChanges, usesSnapshots } from "./snapshots";
import type { Store } from "./store";
import { T } from "./strings";

const SNAPSHOT_BASE = "snapshots";

export type SessionChanges = ReturnType<typeof createSessionChanges>;

export function createSessionChanges({ store, feedback }: { store: Store; feedback: FeedbackRunner }) {
  async function baseOf(agent: Agent) {
    if (agent.feedbackId) return { ref: `feedback:${agent.feedbackId}`, label: T.baseFeedback };
    if (agent.worktree) {
      const ref = await gitOps.mergeBase(agent.cwd, agent.worktree.base);
      return ref ? { ref, label: agent.worktree.base } : null;
    }
    if (!agent.startCommit) return null;
    const ref = await gitOps.sessionBase(agent.cwd, agent.startCommit);
    return { ref, label: T.baseLabel(ref.slice(0, 7)) };
  }

  async function changeSetHas(agent: Agent, absolute: string) {
    if (await isTouched(agent, store, absolute)) return true;
    if (store.change(agent.id, absolute)) return true;
    const base = (await baseOf(agent))?.ref ?? null;
    if (base === null) return false;
    if (agent.feedbackId) return (await feedback.changes(agent.feedbackId)).some((f) => f.path === absolute);
    return (await gitOps.changes(agent.cwd, base)).files.some((f) => f.path === absolute) || (await uncommittedHas(agent, absolute)) || (await branchHas(agent, absolute));
  }

  async function uncommittedHas(agent: Agent, absolute: string) {
    return (await gitOps.headCommit(agent.cwd)) ? (await gitOps.changes(agent.cwd, "HEAD")).files.some((f) => f.path === absolute) : false;
  }

  async function branchHas(agent: Agent, absolute: string) {
    const base = await scopedBase(agent, "branch");
    return base ? (await gitOps.changes(agent.cwd, base)).files.some((f) => f.path === absolute) : false;
  }

  function withSnapshotBase(agent: Agent, info: GitInfo): GitInfo {
    if (info.base || !usesSnapshots(agent)) return info;
    return { ...info, base: SNAPSHOT_BASE, baseLabel: T.baseSnapshots };
  }

  async function changesOf(agent: Agent, requested?: ChangeScope, includeOutside = false) {
    return gitOps.limitToFolder(agent.cwd, await changesWithinRepo(agent, requested), includeOutside);
  }

  async function changesWithinRepo(agent: Agent, requested?: ChangeScope) {
    if (agent.workspaceId === null) return { base: null, files: [] };
    if (agent.feedbackId) return { base: `feedback:${agent.feedbackId}`, files: await feedback.changes(agent.feedbackId) };
    const scope = requested ?? defaultChangeScope(agent);
    if (await listsFromLedger(agent, scope)) return withKeptCounts(agent, scope, await touchedChanges(agent, store));
    const scoped = await scopedBase(agent, scope);
    if (scope === "lastTurn") return touchedLastTurn(agent, store);
    if (scoped) return withKeptCounts(agent, scope, await gitOps.changes(agent.cwd, scoped));
    const base = (await baseOf(agent))?.ref ?? null;
    if (!base && usesSnapshots(agent)) return { base: SNAPSHOT_BASE, files: await snapshotChanges(agent, store) };
    return withKeptCounts(agent, scope, await gitOps.changes(agent.cwd, base));
  }

  async function withKeptCounts<T extends { files: ChangedFile[] }>(agent: Agent, scope: ChangeScope, result: T): Promise<T> {
    if (scope !== "branch" && scope !== "session") return result;
    return { ...result, files: await applyKeptCounts(agent, store, result.files) };
  }

  async function listsFromLedger(agent: Agent, scope: ChangeScope) {
    return scope === "session" && (await ensureLedger(agent, store))?.listsSession === true;
  }

  async function scopedBase(agent: Agent, scope: ChangeScope) {
    if (scope === "uncommitted") return (await gitOps.headCommit(agent.cwd)) ? "HEAD" : null;
    if (scope !== "branch") return null;
    if (agent.worktree) return (await gitOps.mergeBase(agent.cwd, agent.worktree.base)) ?? null;
    const base = await gitOps.defaultBase(agent.cwd);
    return base ? ((await gitOps.mergeBase(agent.cwd, base)) ?? null) : null;
  }

  async function infoOf(agent: Agent): Promise<GitInfo> {
    if (agent.workspaceId === null) return { repoRoot: null, hasHead: false, branch: null, upstream: null, ahead: 0, behind: 0, base: null, baseLabel: null, baseBranch: null };
    const gitInfo = withSnapshotBase(agent, await gitOps.info(agent.cwd, await baseOf(agent)));
    const info = (await listsFromLedger(agent, defaultChangeScope(agent))) ? { ...gitInfo, base: TOUCH_BASE, baseLabel: T.baseTouched } : gitInfo;
    return { ...info, baseBranch: agent.worktree?.base ?? (info.repoRoot ? await gitOps.defaultBase(agent.cwd) : null) };
  }

  async function agentsSharingRepo(dir: string) {
    const root = await gitOps.repoRoot(dir);
    if (!root) return [];
    const realRoot = realDir(root);
    const inside = store.agents.filter((a) => {
      const cwd = realDir(a.cwd);
      return cwd === realRoot || cwd.startsWith(`${realRoot}/`);
    });
    const same = await Promise.all(inside.map(async (a) => ((await gitOps.repoRoot(a.cwd)) === root ? a : null)));
    return same.filter((a): a is Agent => a !== null);
  }

  return { agentsSharingRepo, baseOf, changeSetHas, changesOf, infoOf, listsFromLedger, scopedBase };
}
