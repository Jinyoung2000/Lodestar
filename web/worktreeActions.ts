import type { Agent } from "../shared/protocol";
import { confirmAction } from "./ConfirmDialog";
import { notify } from "./notices";
import { openPrBesideByUrl } from "./prStore";
import { rpc } from "./rpc";
import { flash, getState, refreshGit } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

export const hasWorktree = (agent: Agent | null | undefined): agent is Agent & { worktree: NonNullable<Agent["worktree"]> } => !!agent?.worktree;

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
