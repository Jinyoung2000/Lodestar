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
  // 변경 패널의 기준 커밋: worktree 면 기준 브랜치와의 merge-base, 아니면 세션 시작 시점 HEAD.
  async function baseOf(agent: Agent) {
    // 피드백 개선 세션: 시작 시점의 파일 해시가 기준이다 (커밋 없이도 된다). 실제 비교는 feedback.changes 가 한다.
    if (agent.feedbackId) return { ref: `feedback:${agent.feedbackId}`, label: T.baseFeedback };
    if (agent.worktree) {
      const ref = await gitOps.mergeBase(agent.cwd, agent.worktree.base);
      return ref ? { ref, label: agent.worktree.base } : null;
    }
    if (!agent.startCommit) return null;
    // 세션 시작 뒤 pull 로 들어온 남의 커밋은 세션의 변경이 아니라서 기준을 그만큼 앞으로 옮긴다
    const ref = await gitOps.sessionBase(agent.cwd, agent.startCommit);
    return { ref, label: T.baseLabel(ref.slice(0, 7)) };
  }

  // 쓰기(files.write, changes.undo)가 허용되는 파일: 세션의 변경 집합(장부, git 기준 커밋 대비, Uncommitted, Branch)에 들었거나 유지 기록이 있는 파일.
  // 기준 커밋이 없는 레포(커밋 0개)는 모든 파일이 untracked 라 변경 집합이 곧 전체 파일이므로, 그때는 장부와 유지 기록만 인정한다.
  async function changeSetHas(agent: Agent, absolute: string) {
    if (await isTouched(agent, store, absolute)) return true;
    if (store.change(agent.id, absolute)) return true;
    const base = (await baseOf(agent))?.ref ?? null;
    if (base === null) return false;
    if (agent.feedbackId) return (await feedback.changes(agent.feedbackId)).some((f) => f.path === absolute);
    return (await gitOps.changes(agent.cwd, base)).files.some((f) => f.path === absolute) || (await uncommittedHas(agent, absolute)) || (await branchHas(agent, absolute));
  }

  // Uncommitted Changes 범위(B4-04)에서 보이는 파일도 되돌릴 수 있어야 한다: HEAD 대비 바뀐 파일은 이미 변경 집합이다.
  async function uncommittedHas(agent: Agent, absolute: string) {
    return (await gitOps.headCommit(agent.cwd)) ? (await gitOps.changes(agent.cwd, "HEAD")).files.some((f) => f.path === absolute) : false;
  }

  // 변경 패널의 처음 범위(Branch)에서 보이는 파일도 되돌릴 수 있어야 한다: 기준 브랜치와의 merge-base 대비 바뀐 파일이다.
  async function branchHas(agent: Agent, absolute: string) {
    const base = await scopedBase(agent, "branch");
    return base ? (await gitOps.changes(agent.cwd, base)).files.some((f) => f.path === absolute) : false;
  }

  // 기준 커밋이 없을 때 변경 패널의 기준은 수정 직전 스냅샷이다. 패널이 "기준 없음" 으로 읽지 않게 base 를 채운다.
  function withSnapshotBase(agent: Agent, info: GitInfo): GitInfo {
    if (info.base || !usesSnapshots(agent)) return info;
    return { ...info, base: SNAPSHOT_BASE, baseLabel: T.baseSnapshots };
  }

  // 변경 패널과 칩(범위를 안 보내면 기본 범위 Branch), 사이드바 행과 보드 자동 이동("session")이 같이 쓰는 변경 파일 계산.
  // 세션의 작업 폴더 밖 파일(모노레포의 다른 폴더)은 기본으로 뺀다. 빠진 개수는 outsideCount 로 알려, 패널이 "Show changes outside this folder" 를 보이게 한다.
  async function changesOf(agent: Agent, requested?: ChangeScope, includeOutside = false) {
    return gitOps.limitToFolder(agent.cwd, await changesWithinRepo(agent, requested), includeOutside);
  }

  async function changesWithinRepo(agent: Agent, requested?: ChangeScope) {
    // 폴더 없는 세션(퀵 챗)은 변경 대상이 없다
    if (agent.workspaceId === null) return { base: null, files: [] };
    if (agent.feedbackId) return { base: `feedback:${agent.feedbackId}`, files: await feedback.changes(agent.feedbackId) };
    const scope = requested ?? defaultChangeScope(agent);
    // FIX4A: Session 범위는 이 세션의 에이전트가 만진 파일 장부(server/sessionTouch.ts)로 만든다. 폴더 전체를 비교하지 않는다.
    if (await listsFromLedger(agent, scope)) return withKeptCounts(agent, scope, await touchedChanges(agent, store));
    const scoped = await scopedBase(agent, scope);
    if (scope === "lastTurn") return touchedLastTurn(agent, store);
    if (scoped) return withKeptCounts(agent, scope, await gitOps.changes(agent.cwd, scoped));
    const base = (await baseOf(agent))?.ref ?? null;
    if (!base && usesSnapshots(agent)) return { base: SNAPSHOT_BASE, files: await snapshotChanges(agent, store) };
    return withKeptCounts(agent, scope, await gitOps.changes(agent.cwd, base));
  }

  // Keep 한 변경은 +/- 에서 빠진다. 유지 기록이 기준으로 쓰이는 Branch 와 Session 범위만(web/DiffView.tsx 의 useOriginal 과 같은 규칙)이다. Uncommitted 와 Last Turn 은 자기 기준이 따로 있다.
  async function withKeptCounts<T extends { files: ChangedFile[] }>(agent: Agent, scope: ChangeScope, result: T): Promise<T> {
    if (scope !== "branch" && scope !== "session") return result;
    return { ...result, files: await applyKeptCounts(agent, store, result.files) };
  }

  // Session 범위의 목록을 장부로 만드는 세션: 일반 세션과 갈래. worktree 세션과 커밋 0개 폴더는 Branch 와 같은 git 기준(또는 수정 직전 스냅샷)이다. Branch 와 Uncommitted 는 git 기준 그대로다.
  async function listsFromLedger(agent: Agent, scope: ChangeScope) {
    return scope === "session" && (await ensureLedger(agent, store))?.listsSession === true;
  }

  // 변경 범위 메뉴(B4-04)의 기준 커밋. session 과 git 이 아닌 폴더는 null 이라 기존 계산(baseOf)을 쓴다.
  // branch: 기준 브랜치와 HEAD 의 merge-base, uncommitted: HEAD.
  async function scopedBase(agent: Agent, scope: ChangeScope) {
    if (scope === "uncommitted") return (await gitOps.headCommit(agent.cwd)) ? "HEAD" : null;
    if (scope !== "branch") return null;
    if (agent.worktree) return (await gitOps.mergeBase(agent.cwd, agent.worktree.base)) ?? null;
    const base = await gitOps.defaultBase(agent.cwd);
    return base ? ((await gitOps.mergeBase(agent.cwd, base)) ?? null) : null;
  }

  // 패널 머리와 제목줄이 쓰는 git 상태. baseBranch 는 Branch Changes 메뉴 설명에 보인다.
  async function infoOf(agent: Agent): Promise<GitInfo> {
    if (agent.workspaceId === null) return { repoRoot: null, hasHead: false, branch: null, upstream: null, ahead: 0, behind: 0, base: null, baseLabel: null, baseBranch: null };
    const gitInfo = withSnapshotBase(agent, await gitOps.info(agent.cwd, await baseOf(agent)));
    const info = (await listsFromLedger(agent, defaultChangeScope(agent))) ? { ...gitInfo, base: TOUCH_BASE, baseLabel: T.baseTouched } : gitInfo;
    return { ...info, baseBranch: agent.worktree?.base ?? (info.repoRoot ? await gitOps.defaultBase(agent.cwd) : null) };
  }

  // BRANCH-SWITCH: dir 와 같은 저장소 작업 트리를 쓰는 세션. 폴더가 저장소 안에 있는 세션만 git 으로 다시 확인한다(worktree 세션은 저장소 밖 폴더라 빠진다).
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
