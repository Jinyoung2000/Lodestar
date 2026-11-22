import type { GitProblem } from "../shared/gitProblems";
import type { ScmPullMode, ScmSyncResult, ScmTarget } from "../shared/scm";
import { confirmDialog } from "./ConfirmDialog";
import { notify, type NoticeAction } from "./notices";
import { rpc } from "./rpc";
import { openScmFile } from "./scmOpen";
import { M } from "./scmStrings";
import { flash, openSourceControl } from "./store";
import { S } from "./strings";
import { hint } from "./hint";


export type SyncOutcome = "ok" | "conflict" | "cancelled" | "failed";

type Remote = { branch: string | null; upstream: string | null; ahead: number; behind: number };

const NOTICE_KEY = "git-problem";

export async function fetchFlow(target: ScmTarget, options: { quiet?: boolean } = {}): Promise<SyncOutcome> {
  const result = await rpc.call("scm.fetch", target);
  if (result.ok) {
    if (!options.quiet) hint(M.fetchDone, undefined, { check: true });
    return "ok";
  }
  return report(target, result, () => void fetchFlow(target, options));
}

export async function pullFlow(target: ScmTarget, mode: ScmPullMode = "ff", options: { quiet?: boolean } = {}): Promise<SyncOutcome> {
  const result = await rpc.call("scm.pull", { ...target, mode });
  if (result.ok) {
    if (!options.quiet && /up to date/i.test(result.output)) hint(M.upToDate);
    else if (!options.quiet) flash(M.pullDone);
    return "ok";
  }
  if (result.problem.kind === "diverged" && mode === "ff") {
    const chosen = await askReconcile(target, "diverged");
    return chosen === null ? "cancelled" : pullFlow(target, chosen, options);
  }
  return report(target, result, () => void pullFlow(target, mode, options));
}

export async function pushFlow(target: ScmTarget, options: { quiet?: boolean } = {}): Promise<SyncOutcome> {
  const result = await rpc.call("scm.push", target);
  if (result.ok) {
    if (!options.quiet) flash(M.pushDone);
    return "ok";
  }
  if (result.problem.kind !== "pushRejected") return report(target, result, () => void pushFlow(target, options));
  const chosen = await askReconcile(target, "pushRejected");
  if (chosen === null) return "cancelled";
  const pulled = await pullFlow(target, chosen, { quiet: true });
  if (pulled !== "ok") return pulled;
  const again = await rpc.call("scm.push", target);
  if (again.ok) {
    if (!options.quiet) flash(M.pushDone);
    return "ok";
  }
  return report(target, again, () => void pushFlow(target, options));
}

async function askReconcile(target: ScmTarget, reason: "diverged" | "pushRejected"): Promise<ScmPullMode | null> {
  const remote = await remoteOf(target);
  const upstream = remote.upstream ?? M.divergedGeneric;
  const choice = await confirmDialog({
    title: reason === "diverged" ? M.divergedTitle(remote.branch ?? "HEAD", upstream) : M.pushRejectedTitle(upstream),
    detail: reason === "diverged" ? M.divergedDetail(remote.branch ?? "HEAD", upstream, remote.ahead, remote.behind) : M.pushRejectedDetail,
    buttons: [S.cancel, M.pullRebase, M.pullMerge],
    severity: "warning",
    primary: 2,
  });
  return choice === 1 ? "rebase" : choice === 2 ? "merge" : null;
}

async function remoteOf(target: ScmTarget): Promise<Remote> {
  try {
    const status = await rpc.call("scm.status", target);
    return { branch: status.detached ? null : status.branch, upstream: status.upstream, ahead: status.ahead, behind: status.behind };
  } catch {
    return { branch: null, upstream: null, ahead: 0, behind: 0 };
  }
}

function report(target: ScmTarget, result: Extract<ScmSyncResult, { ok: false }>, retry: () => void): SyncOutcome {
  const { problem, output } = result;
  if (problem.kind === "conflict") {
    notify({
      message: problem.title,
      detail: `${M.conflictDetail(result.conflicts ?? 0)} ${problem.hint}`,
      severity: "warning",
      key: NOTICE_KEY,
      actions: [{ label: M.openConflicts, primary: true, run: () => void showConflicts(target) }],
    });
    return "conflict";
  }
  notify({
    message: problem.title,
    detail: detailOf(problem),
    severity: "error",
    key: NOTICE_KEY,
    actions: actionsFor(problem, output, retry),
  });
  return "failed";
}

const detailOf = (problem: GitProblem) => (problem.files?.length ? `${problem.hint} ${M.dirtyFiles(problem.files)}` : problem.hint);

function actionsFor(problem: GitProblem, output: string, retry: () => void): NoticeAction[] {
  const copy = (text: string) => () => {
    void navigator.clipboard?.writeText(text).then(() => hint(M.copied, undefined, { check: true }));
  };
  const details: NoticeAction = { label: M.copyDetails, run: copy(output.trim() || problem.title) };
  if (problem.kind === "dirty" || problem.kind === "locked") return [{ label: M.retry, primary: true, run: retry }, details];
  if (problem.kind === "inProgress") return [{ label: M.showSourceControl, primary: true, run: openSourceControl }, details];
  if (problem.kind === "noUpstream") {
    const command = /git push -u origin \S+/.exec(problem.hint)?.[0];
    return command ? [{ label: M.copyCommand, primary: true, run: copy(command) }, details] : [details];
  }
  return [{ label: M.retry, run: retry }, { ...details, primary: true }];
}

export async function showConflicts(target: ScmTarget & { workspaceId?: string }) {
  openSourceControl();
  try {
    const status = await rpc.call("scm.status", target);
    const first = status.conflicts[0];
    if (first && target.workspaceId) openScmFile(target.workspaceId, first);
  } catch {
  }
}
