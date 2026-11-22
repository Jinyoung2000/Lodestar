import { useCallback, useRef, useState } from "react";
import type { ScmCommitOptions, ScmEntry, ScmStatus } from "../shared/scm";
import { confirmAction, confirmDialog } from "./ConfirmDialog";
import { fetchFlow, pullFlow, pushFlow, showConflicts } from "./gitSync";
import { rpc } from "./rpc";
import { openScmChanges, openScmFile } from "./scmOpen";
import { M } from "./scmStrings";
import { flash, getState, refreshGit } from "./store";
import { reloadWorkspaceChanges } from "./workspaceChanges";
import { hint } from "./hint";

export type CommitFailure = { output: string; hook: boolean; options: ScmCommitOptions };

type Params = { agentId: string | null; workspaceId: string; status: ScmStatus; reload: () => Promise<void>; message: string; setMessage: (text: string) => void };

export function useScmActions({ agentId, workspaceId, status, reload, message, setMessage }: Params) {
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [failure, setFailure] = useState<CommitFailure | null>(null);
  const target = { agentId: agentId ?? undefined, workspaceId };
  const exclusive = useRef(false);
  const once = async (job: () => Promise<void>) => {
    if (exclusive.current) return;
    exclusive.current = true;
    try {
      await run(job);
    } finally {
      exclusive.current = false;
    }
  };

  const run = useCallback(
    async (job: () => Promise<void>) => {
      setBusy(true);
      try {
        await job();
      } catch (error) {
        flash((error as Error).message, "error");
      } finally {
        setBusy(false);
        await reload();
        if (agentId) void refreshGit(agentId);
        void reloadWorkspaceChanges(workspaceId);
      }
    },
    [agentId, reload, workspaceId],
  );

  const stage = (entries: readonly ScmEntry[]) => run(async () => void (await rpc.call("scm.stage", { ...target, paths: entries.map((e) => e.rel) })));
  const unstage = (entries: readonly ScmEntry[]) => run(async () => void (await rpc.call("scm.unstage", { ...target, paths: entries.map((e) => e.rel) })));

  const discard = async (entries: readonly ScmEntry[], folderName?: string) => {
    if (entries.length === 0) return;
    const fresh = entries.filter((e) => e.code === "U" || e.code === "A").length;
    const tracked = entries.length - fresh;
    const name = entries[0].rel.slice(entries[0].rel.lastIndexOf("/") + 1);
    const single = entries.length === 1 && !folderName;
    const ok = single
      ? await confirmAction(fresh ? M.trashFileTitle(name) : M.discardFileTitle(name), fresh ? M.trashFileButton : M.discardFileButton, fresh ? M.trashFileDetail : M.discardFileDetail, "warning")
      : await confirmAction(M.discardManyTitle(entries.length), M.discardManyButton(entries.length), M.discardManyDetail(tracked, fresh), "warning");
    if (!ok) return;
    await run(async () => {
      const result = await rpc.call("scm.discard", { ...target, paths: entries.map((e) => e.rel) });
      if (!single) flash(M.discarded(result.restored, result.trashed));
    });
  };

  const commit = (options: Omit<ScmCommitOptions, "message">) =>
    once(async () => {
      if (!message.trim() && !options.amend) {
        hint(M.needMessage);
        return;
      }
      setFailure(null);
      let current: ScmCommitOptions = { ...options, message };
      for (;;) {
        const result = await rpc.call("scm.commit", { ...target, options: current });
        if (result.status === "needsStageAll") {
          const ok = await confirmAction(M.noStagedTitle, M.stageAllAndCommit, M.noStagedDetail);
          if (!ok) return;
          current = { ...current, stageAll: true };
        } else if (result.status === "amendPushed") {
          const ok = await confirmAction(M.amendPushedTitle, M.amend, M.amendPushedDetail);
          if (!ok) return;
          current = { ...current, confirmPushedAmend: true };
        } else if (result.status === "conflicts") {
          flash(M.resolveConflicts, "warning");
          return;
        } else if (result.status === "nothingToCommit") {
          hint(M.nothingToCommit);
          return;
        } else if (result.status === "failed") {
          setFailure({ output: result.output, hook: result.hook, options: current });
          return;
        } else {
          setMessage("");
          flash(M.committed(result.summary));
          if (result.pushError) flash(M.pushFailedAfterCommit(result.pushError), "error");
          return;
        }
      }
    });

  const commitWithoutHooks = () => {
    if (!failure) return Promise.resolve();
    const { message: _kept, ...rest } = failure.options;
    return commit({ ...rest, noVerify: true });
  };

  const undoLastCommit = async () => {
    const last = status.lastCommit;
    if (!last) return;
    const ok = await confirmAction(M.undoTitle, M.undo, last.parents > 1 ? M.undoMergeDetail(last.subject) : M.undoDetail(last.subject, last.pushed));
    if (!ok) return;
    await run(async () => {
      const result = await rpc.call("scm.undoCommit", target);
      setMessage(result.message);
      flash(M.undone);
    });
  };

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const model = getState().settings?.quickModel ?? "haiku";
      const result = await rpc.call("scm.generateMessage", { ...target, model });
      setMessage(result.message);
    } catch (error) {
      flash(M.generateFailed((error as Error).message), "error");
    } finally {
      setGenerating(false);
    }
  };

  const sync = async (verb: "pull" | "push" | "fetch", mode?: "merge" | "rebase") => {
    await once(async () => {
      if (verb === "fetch") await fetchFlow(target);
      else if (verb === "pull") await pullFlow(target, mode);
      else await pushFlow(target);
    });
  };

  const syncChanges = () =>
    once(async () => {
      if (status.behind > 0 && (await pullFlow(target)) !== "ok") return;
      if (status.ahead > 0) await pushFlow(target);
    });

  const continueOperation = () =>
    run(async () => {
      const merge = status.operation === "merge";
      const result = await rpc.call("scm.continue", { ...target, ...(merge ? { message } : {}) });
      if (result.ok) {
        if (merge) setMessage("");
        flash(merge ? M.mergeContinued : M.rebaseContinued);
        return;
      }
      if (result.problem.kind === "conflict") {
        flash(`${result.problem.title}. ${result.problem.hint}`, "warning");
        void showConflicts({ ...target, workspaceId });
        return;
      }
      flash(`${M.continueFailed}: ${result.problem.title}. ${result.problem.hint}`, "error");
    });

  const abortOperation = async () => {
    const merge = status.operation === "merge";
    const ok = await confirmAction(merge ? M.abortMergeTitle : M.abortRebaseTitle, merge ? M.abortMerge : M.abortRebase, merge ? M.abortMergeDetail : M.abortRebaseDetail, "warning");
    if (!ok) return;
    await run(async () => {
      await rpc.call("scm.abort", target);
      if (merge) setMessage("");
      flash(merge ? M.mergeAborted : M.rebaseAborted);
    });
  };

  const openEntry = (entry: ScmEntry, side = false) => openScmFile(workspaceId, entry, side);
  const openChanges = (entry: ScmEntry, group: "merge" | "staged" | "changes", side = false) => openScmChanges({ ...target, workspaceId }, entry, group, side);

  return { busy, generating, failure, dismissFailure: () => setFailure(null), stage, unstage, discard, commit, commitWithoutHooks, undoLastCommit, generate, sync, syncChanges, continueOperation, abortOperation, openEntry, openChanges, confirmDialog };
}

export type ScmActions = ReturnType<typeof useScmActions>;
