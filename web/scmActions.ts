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

// SCM: Source Control 보기의 동작. 서버 호출, 확인 창, 알림을 묶는다. 어떤 동작도 확인 없이 파일을 잃게 하지 않는다.

export type CommitFailure = { output: string; hook: boolean; options: ScmCommitOptions };

type Params = { agentId: string | null; workspaceId: string; status: ScmStatus; reload: () => Promise<void>; message: string; setMessage: (text: string) => void };

export function useScmActions({ agentId, workspaceId, status, reload, message, setMessage }: Params) {
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [failure, setFailure] = useState<CommitFailure | null>(null);
  const target = { agentId: agentId ?? undefined, workspaceId };
  // 커밋, pull, push, fetch 가 도는 동안 같은 동작이 또 시작되지 않게 한다. Commit 단추는 busy 로 꺼지지만 ⌘Enter(누르고 있으면 반복된다)와 더보기 메뉴의 Pull, Push 는 꺼지지 않는다.
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

  // 서버 호출을 한 번에 하나씩 돌리고, 끝나면 상태와 변경 패널을 다시 읽는다.
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
        // 새 세션 화면의 Changes 탭과 배지도 같은 폴더의 변경을 보고 있다
        void reloadWorkspaceChanges(workspaceId);
      }
    },
    [agentId, reload, workspaceId],
  );

  const stage = (entries: readonly ScmEntry[]) => run(async () => void (await rpc.call("scm.stage", { ...target, paths: entries.map((e) => e.rel) })));
  const unstage = (entries: readonly ScmEntry[]) => run(async () => void (await rpc.call("scm.unstage", { ...target, paths: entries.map((e) => e.rel) })));

  // 버릴 변경: 추적 파일은 되돌리고 새 파일은 휴지통으로 옮긴다. 반드시 확인을 거친다.
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

  // 커밋. 서버가 되돌려 주는 상태에 따라 확인 창을 거쳐 한 번 더 부른다.
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

  // 훅이 실패한 커밋을 사용자가 고른 경우에만 훅 없이 다시 한다
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

  // FIX6B: pull, push, fetch 는 세션이 아니라 이 보기가 보여 주는 저장소에 한다(scm.* RPC). 실패는 gitSync 가 분류해 알린다.
  const sync = async (verb: "pull" | "push" | "fetch", mode?: "merge" | "rebase") => {
    await once(async () => {
      if (verb === "fetch") await fetchFlow(target);
      else if (verb === "pull") await pullFlow(target, mode);
      else await pushFlow(target);
    });
  };

  // FIX6B: 진행 중인 병합이나 리베이스를 이어간다. 충돌이 남았거나 다음 커밋에서 또 충돌하면 멈추고 이유를 알린다.
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

  // 병합이나 리베이스를 시작 전으로 되돌린다. 푼 충돌도 사라지므로 확인을 거친다.
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
  // 변경 보기: 세션이 있든 없든 이 보기가 보여 주는 저장소의 인덱스 기준 diff 탭. 충돌 파일은 충돌 해결 도구가 붙는 편집기로 간다.
  const openChanges = (entry: ScmEntry, group: "merge" | "staged" | "changes", side = false) => openScmChanges({ ...target, workspaceId }, entry, group, side);

  return { busy, generating, failure, dismissFailure: () => setFailure(null), stage, unstage, discard, commit, commitWithoutHooks, undoLastCommit, generate, sync, continueOperation, abortOperation, openEntry, openChanges, confirmDialog };
}

export type ScmActions = ReturnType<typeof useScmActions>;
