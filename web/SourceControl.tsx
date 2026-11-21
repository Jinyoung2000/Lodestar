import "./scm.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ScmStatus } from "../shared/scm";
import { activeAgentOf } from "./activeAgentOf";
import { Codicon } from "./icons";
import { useScmActions, type ScmActions } from "./scmActions";
import { scmDraftKey, setScmDraft, setScmTree, useScmStatus, useScmView } from "./scmState";
import { M } from "./scmStrings";
import { ScmGraph, ScmWorktrees } from "./ScmExtras";
import { ScmGroup } from "./ScmRows";
import { inFolder, setState, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

// Source Control 보기: 오른쪽 패널의 고정 탭 본문. 대상은 지금 칸 세션의 작업 폴더 저장소이고,
// 세션이 없으면 새 세션 화면에서 고른 폴더, 그것도 없으면 마지막으로 연 작업 폴더다.
export function SourceControlTab() {
  const agent = useStore((s) => activeAgentOf(s.panes, s.activePaneId, s.agents));
  const draftWorkspaceId = useStore((s) => {
    const pane = s.panes.find((p) => p.id === s.activePaneId);
    return pane?.kind === "draft" ? pane.workspaceId : null;
  });
  const lastWorkspaceId = useStore((s) => (s.workspaces.some((w) => w.id === s.activeWorkspaceId) ? s.activeWorkspaceId : null));
  if (agent) {
    if (!inFolder(agent)) return <div className="empty-hint">{M.chatNoRepo}</div>;
    return <ScmView key={agent.id} agentId={agent.id} workspaceId={agent.workspaceId} />;
  }
  const workspaceId = draftWorkspaceId || lastWorkspaceId;
  if (!workspaceId) return <div className="empty-hint">{M.noFolderText}</div>;
  return <ScmView key={workspaceId} agentId={null} workspaceId={workspaceId} />;
}

function ScmView({ agentId, workspaceId }: { agentId: string | null; workspaceId: string }) {
  const { status, error, reload } = useScmStatus(agentId, workspaceId);
  if (!status) return <div className="empty-hint">{error ? M.statusFailed(error) : M.loading}</div>;
  if (!status.repoRoot) {
    return (
      <div className="changes-empty">
        <strong>{M.noRepoTitle}</strong>
        <span>{M.noRepoText}</span>
      </div>
    );
  }
  return <ScmLoaded agentId={agentId} workspaceId={workspaceId} status={status} reload={reload} />;
}

function ScmLoaded({ agentId, workspaceId, status, reload }: { agentId: string | null; workspaceId: string; status: ScmStatus; reload: () => Promise<void> }) {
  const draftKey = scmDraftKey(agentId, workspaceId);
  const message = useScmView((v) => v.drafts[draftKey] ?? "");
  const tree = useScmView((v) => v.tree);
  const actions = useScmActions({ agentId, workspaceId, status, reload, message, setMessage: (text) => setScmDraft(draftKey, text) });
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const findTitleSlot = useCallback((element: HTMLDivElement | null) => setTitleSlot(element?.closest(".focus-side")?.querySelector<HTMLElement>(SCM_TITLE_SLOT) ?? null), []);
  // 커밋, 브랜치, 앞섬이 바뀌면 Worktrees 와 Graph 를 다시 읽는다
  const refreshKey = `${status.repoRoot}|${status.branch}|${status.lastCommit?.hash}|${status.ahead}|${status.behind}`;
  const nothing = status.staged.length + status.changes.length + status.conflicts.length === 0;
  // FIX6B: 병합이 시작되면 git 이 만든 병합 메시지(MERGE_MSG)를 커밋 칸에 채운다. 사용자가 이미 쓴 글은 덮지 않는다.
  useEffect(() => {
    if (status.operation === "merge" && status.mergeMessage && !message) setScmDraft(draftKey, status.mergeMessage);
    // 메시지를 일부러 비웠을 때 다시 채우지 않도록 병합이 바뀔 때만 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.operation, status.mergeMessage, draftKey]);
  const titleActions = <ScmTitleActions status={status} tree={tree} actions={actions} reload={reload} />;
  return (
    <div className="scm-view" aria-label={M.viewAria} ref={findTitleSlot}>
      {titleSlot ? createPortal(titleActions, titleSlot) : <div className="scm-head" role="toolbar" aria-label={S.scmTitleActionsAria}>{titleActions}</div>}
      <div className="scm-top">
        <CommitBox status={status} message={message} actions={actions} onMessage={(text) => setScmDraft(draftKey, text)} />
      </div>
      <div className="scm-body">
        {status.operation && <OperationBar status={status} actions={actions} />}
        {actions.failure && <CommitFailure actions={actions} />}
        {status.conflicts.length > 0 && <ScmGroup kind="merge" entries={status.conflicts} tree={tree} actions={actions} />}
        {status.staged.length > 0 && <ScmGroup kind="staged" entries={status.staged} tree={tree} actions={actions} />}
        {status.changes.length > 0 && <ScmGroup kind="changes" entries={status.changes} tree={tree} actions={actions} />}
        {nothing && (
          <div className="scm-clean">
            <strong>{M.noChanges}</strong>
            <span>{M.noChangesText}</span>
          </div>
        )}
      </div>
      <div className="scm-dock">
        <ScmWorktrees currentRoot={status.repoRoot ?? ""} refreshKey={refreshKey} />
        <ScmGraph target={{ agentId: agentId ?? undefined, workspaceId }} refreshKey={refreshKey} />
      </div>
    </div>
  );
}

const SCM_TITLE_SLOT = '.focus-side-actions[data-slot="scm"]';

function hasWorkOf(status: ScmStatus) {
  return status.staged.length + status.changes.length + status.conflicts.length > 0 || status.merging;
}

function ScmTitleActions({ status, tree, actions, reload }: { status: ScmStatus; tree: boolean; actions: ScmActions; reload: () => Promise<void> }) {
  return (
    <>
      <Button size="icon" aria-label={M.commit} title={M.commit} disabled={actions.busy || !hasWorkOf(status)} onClick={() => void actions.commit({})}>
        <Codicon name="check" />
      </Button>
      <Button size="icon" aria-label={M.refresh} title={M.refresh} onClick={() => void reload()}>
        <Codicon name="refresh" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" aria-label={M.moreActions} title={M.moreActions}>
            <Codicon name="more" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setScmTree(!tree)}>{tree ? M.viewAsList : M.viewAsTree}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!status.upstream} onSelect={() => void actions.sync("pull")}>
            {M.pull}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!status.upstream} onSelect={() => void actions.sync("pull", "merge")}>
            {M.pullMerge}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!status.upstream} onSelect={() => void actions.sync("pull", "rebase")}>
            {M.pullRebase}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!status.hasRemote} onSelect={() => void actions.sync("push")}>
            {M.push}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!status.hasRemote} onSelect={() => void actions.sync("fetch")}>
            {M.fetch}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!status.hasHead} onSelect={() => void actions.undoLastCommit()}>
            {M.undoLastCommit}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

// 커밋 메시지 입력(⌘Enter 로 커밋), 메시지 생성 단추, Commit 단추와 옵션 메뉴
function CommitBox({ status, message, actions, onMessage }: { status: ScmStatus; message: string; actions: ScmActions; onMessage: (text: string) => void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  // ⌃⇧G 와 "Source Control: Focus Commit Message" 가 보낸 요청. 상태를 읽어 오느라 입력이 늦게 마운트되어도 3초 안이면 받는다.
  const focusRequest = useStore((s) => s.focusScmMessage);
  useEffect(() => {
    if (focusRequest === null) return;
    if (Date.now() - focusRequest < 3000) field.current?.focus();
    setState({ focusScmMessage: null });
  }, [focusRequest]);
  const hasWork = hasWorkOf(status);
  const syncable = !hasWork && !!status.upstream && status.ahead + status.behind > 0;
  // 입력이 빈 채 Commit 을 눌러 알림이 뜬 경우 입력으로 돌아간다
  const commit = (options: Parameters<ScmActions["commit"]>[0]) => {
    if (!message.trim() && !options.amend) field.current?.focus();
    return actions.commit(options);
  };
  return (
    <div className="scm-commit-box">
      <div className="scm-input">
        <textarea
          ref={field}
          className="scm-message"
          aria-label={M.messageLabel}
          placeholder={M.messagePlaceholder(status.detached ? null : status.branch)}
          rows={1}
          value={message}
          spellCheck={false}
          onChange={(e) => onMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.stopPropagation();
              void commit({});
            }
          }}
        />
        <span className="scm-generate">
          <Button size="icon" aria-label={actions.generating ? M.generating : M.generate} title={actions.generating ? M.generating : M.generate} disabled={actions.generating || !hasWork} onClick={() => void actions.generate()}>
            <Codicon name={actions.generating ? "loading" : "sparkle"} spin={actions.generating} />
          </Button>
        </span>
      </div>
      {syncable ? (
        <div className="scm-commit-buttons">
          <Button variant="primary" className="scm-commit scm-sync" title={M.aheadBehind(status.ahead, status.behind)} disabled={actions.busy} onClick={() => void actions.syncChanges()}>
            <Codicon name="sync" />
            {M.syncChangesLabel(status.ahead, status.behind)}
          </Button>
        </div>
      ) : (
        <div className="scm-commit-buttons">
          <Button variant="primary" className="scm-commit" data-idle={!hasWork || undefined} disabled={actions.busy || !hasWork} onClick={() => void commit({})}>
            <Codicon name="check" />
            {M.commit}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="primary" className="scm-commit-more" data-idle={!hasWork || undefined} aria-label={M.commitMore} title={M.commitMore} disabled={actions.busy}>
                <Codicon name="chevron-down" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!hasWork} onSelect={() => void commit({})}>
                {M.commit}
                <span className="faint xs menu-hint">⌘↵</span>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!hasWork} onSelect={() => void commit({ then: "push" })}>
                {M.commitAndPush}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!hasWork} onSelect={() => void commit({ then: "sync" })}>
                {M.commitAndSync}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!status.hasHead} onSelect={() => void commit({ amend: true })}>
                {M.commitAmend}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!status.hasHead} onSelect={() => void actions.undoLastCommit()}>
                {M.undoLastCommit}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

// 커밋이 실패했을 때 git 이 낸 출력 전문. 훅이 막은 경우에만 훅 없이 다시 하는 단추를 둔다.
function CommitFailure({ actions }: { actions: ScmActions }) {
  const failure = actions.failure;
  const box = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    box.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);
  if (!failure) return null;
  return (
    <div className="scm-failure" role="alert">
      <div className="scm-failure-title">
        <Codicon name="error" />
        <strong>{failure.hook ? M.hookFailed : M.commitFailed}</strong>
        <span className="spacer" />
        <Button size="icon" aria-label={M.dismiss} title={M.dismiss} onClick={actions.dismissFailure}>
          <Codicon name="close" />
        </Button>
      </div>
      <pre className="scm-failure-output" ref={box}>
        {failure.output}
      </pre>
      {failure.hook && (
        <div className="scm-failure-actions">
          <Button variant="secondary" size="sm" title={M.commitWithoutHooksHint} disabled={actions.busy} onClick={() => void actions.commitWithoutHooks()}>
            {M.commitWithoutHooks}
          </Button>
        </div>
      )}
    </div>
  );
}

// FIX6B: 병합이나 리베이스가 진행 중일 때 목록 위에 뜨는 띠. 충돌이 남았는지 알리고, 다 풀리면 이어가기를, 언제든 중단을 고른다.
function OperationBar({ status, actions }: { status: ScmStatus; actions: ScmActions }) {
  const merge = status.operation === "merge";
  const left = status.conflicts.length;
  return (
    <div className="scm-operation" role="status" data-operation={status.operation}>
      <div className="scm-operation-title">
        <Codicon name={merge ? "git-merge" : "git-branch-changes"} />
        <strong>{merge ? M.mergeInProgress : M.rebaseInProgress}</strong>
        {status.operationText && (
          <span className="scm-operation-text" title={status.operationText}>
            {status.operationText}
          </span>
        )}
      </div>
      <div className="scm-operation-state" data-resolved={left === 0 || undefined}>
        {left > 0 ? M.opConflictsLeft(left) : M.opAllResolved}
      </div>
      <div className="scm-operation-actions">
        <Button variant="primary" size="sm" disabled={actions.busy || left > 0} onClick={() => void actions.continueOperation()}>
          {merge ? M.continueMerge : M.continueRebase}
        </Button>
        <Button variant="secondary" size="sm" disabled={actions.busy} onClick={() => void actions.abortOperation()}>
          {merge ? M.abortMerge : M.abortRebase}
        </Button>
      </div>
    </div>
  );
}
