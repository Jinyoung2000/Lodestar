import type { Agent } from "../shared/protocol";
import { confirmAction } from "./ConfirmDialog";
import { notify } from "./notices";
import { openPrBesideByUrl } from "./prStore";
import { rpc } from "./rpc";
import { flash, getState, refreshGit } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

// FIX4A: 워크트리 세션의 마무리(dogfood 4회차 7번). 세션 행 메뉴와 명령 팔레트가 같이 쓴다.
export const hasWorktree = (agent: Agent | null | undefined): agent is Agent & { worktree: NonNullable<Agent["worktree"]> } => !!agent?.worktree;

// 기준 브랜치로 합친다. 서버가 합칠 수 없는 이유(기준 브랜치 없음, 변경 안 된 커밋 없음, 작업 트리가 더러움)를 먼저 알려 주고, 충돌이면 중단하고 되돌린 채 알린다.
export async function mergeWorktree(agentId: string) {
  const agent = getState().agents.find((a) => a.id === agentId);
  if (!hasWorktree(agent)) {
    hint(S.worktreeOnly);
    return;
  }
  try {
    const info = await rpc.call("worktree.mergeInfo", { agentId });
    if (!info) return;
    if (info.blocker) {
      flash(info.blocker, "warning");
      return;
    }
    if (!(await confirmAction(S.mergeTitle(info.branch, info.target), S.mergeButton, S.mergeDetail(info.unmerged, info.target)))) return;
    const result = await rpc.call("worktree.merge", { agentId, confirmed: true });
    flash(S.merged(info.branch, result.target, result.commits, result.fastForward));
    for (const id of [agentId, ...result.affectedAgentIds]) void refreshGit(id);
  } catch (error) {
    flash((error as Error).message, "error");
  }
}

// PR 준비. 브랜치를 origin 에 push 하고, gh 가 있으면 PR 까지 만든다(브라우저는 열지 않는다). 없으면 비교 URL 을 복사한다.
export async function createWorktreePr(agentId: string) {
  const agent = getState().agents.find((a) => a.id === agentId);
  if (!hasWorktree(agent)) {
    hint(S.worktreeOnly);
    return;
  }
  const { branch, base } = agent.worktree;
  if (!(await confirmAction(S.prTitle(branch), S.prButton, S.prDetail(base)))) return;
  try {
    const result = await rpc.call("worktree.createPr", { agentId, confirmed: true });
    const url = result.url;
    if (result.kind === "pushed") {
      if (url) await navigator.clipboard.writeText(url).then(() => undefined, () => undefined);
      flash(url ? `${result.message}. ${S.compareLinkCopied}` : result.message);
    } else {
      notify({ message: result.message, key: "worktree-pr", actions: url ? [{ label: S.openPr, run: () => openPrBesideByUrl(url, agentId) }] : [] });
    }
    void refreshGit(agentId);
  } catch (error) {
    flash((error as Error).message, "error");
  }
}
