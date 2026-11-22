import "./scm.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "../shared/protocol";
import { useMissingFolders } from "./missingFolders";
import { isMultiRoot, sessionRoots } from "./sessionFolders";
import { createPortal } from "react-dom";
import type { ScmStatus } from "../shared/scm";
import { activeAgentOf } from "./activeAgentOf";
import { Codicon } from "./icons";
import { editorGitWorkspaceOf } from "./editorChat";
import { useScmActions, type ScmActions } from "./scmActions";
import { scmDraftKey, setScmDraft, setScmTree, useScmStatus, useScmView } from "./scmState";
import { M } from "./scmStrings";
import { ScmGraph, ScmWorktrees } from "./ScmExtras";
import { ScmGroup } from "./ScmRows";
import { inFolder, setState, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

export function SourceControlTab() {
  const agent = useStore((s) => activeAgentOf(s.panes, s.activePaneId, s.agents));
  const editorWorkspaceId = useStore(editorGitWorkspaceOf);
  const draftWorkspaceId = useStore((s) => {
    const pane = s.panes.find((p) => p.id === s.activePaneId);
    return pane?.kind === "draft" ? pane.workspaceId : null;
  });
  const lastWorkspaceId = useStore((s) => (s.workspaces.some((w) => w.id === s.activeWorkspaceId) ? s.activeWorkspaceId : null));
  if (agent) {
    if (!inFolder(agent)) return <div className="empty-hint">{M.chatNoRepo}</div>;
    if (isMultiRoot(agent)) return <ScmRepos key={agent.id} agent={agent} editorWorkspaceId={editorWorkspaceId} />;
    if (editorWorkspaceId) return <ScmView key={editorWorkspaceId} agentId={null} workspaceId={editorWorkspaceId} />;
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

function ScmRepos({ agent, editorWorkspaceId }: { agent: Agent; editorWorkspaceId: string | null }) {
  const workspaces = useStore((s) => s.workspaces);
  const missingFolders = useMissingFolders();
  const roots = useMemo(() => {
    const primary = editorWorkspaceId ? workspaces.find((workspace) => workspace.id === editorWorkspaceId) : undefined;
    return sessionRoots(agent, workspaces)
      .filter((root) => root.primary || root.id !== primary?.id)
      .map((root) => root.primary && primary ? { ...root, id: primary.id, workspace: primary, label: primary.name } : root)
      .filter((root) => root.workspace && !missingFolders.has(root.id));
  }, [agent, workspaces, missingFolders, editorWorkspaceId]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set(roots.filter((r) => !r.primary).map((r) => r.id)));
  const toggle = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="scm-multi" role="tree" aria-label={S.scmReposAria}>
      {roots.map((root) => (
        <ScmRepo key={root.id} agentId={root.primary && !editorWorkspaceId ? agent.id : null} workspaceId={root.id} label={root.label} primary={root.primary} open={!closed.has(root.id)} onToggle={() => toggle(root.id)} />
      ))}
    </div>
  );
}

function ScmRepo({ agentId, workspaceId, label, primary, open, onToggle }: { agentId: string | null; workspaceId: string; label: string; primary: boolean; open: boolean; onToggle: () => void }) {
  const { status, reload } = useScmStatus(agentId, workspaceId);
  if (!status?.repoRoot) return null;
  const count = status.staged.length + status.changes.length + status.conflicts.length;
  return (
    <div role="group">
      <button type="button" role="treeitem" aria-expanded={open} className="scm-root" onClick={onToggle}>
        <Codicon name={open ? "chevron-down" : "chevron-right"} size={14} />
        <Codicon name="repo" size={14} />
        <span className="scm-root-name">{label}</span>
        {status.branch && (
          <span className="scm-root-branch">
            <Codicon name="git-branch" size={12} />
            {status.branch}
          </span>
        )}
        {count > 0 && <span className="scm-root-count">{count}</span>}
      </button>
      {open && <ScmLoaded agentId={agentId} workspaceId={workspaceId} status={status} reload={reload} compact titleActions={primary} />}
    </div>
  );
}

function ScmLoaded({ agentId, workspaceId, status, reload, compact = false, titleActions: showTitle = true }: { agentId: string | null; workspaceId: string; status: ScmStatus; reload: () => Promise<void>; compact?: boolean; titleActions?: boolean }) {
  const draftKey = scmDraftKey(agentId, workspaceId);
  const message = useScmView((v) => v.drafts[draftKey] ?? "");
  const tree = useScmView((v) => v.tree);
  const actions = useScmActions({ agentId, workspaceId, status, reload, message, setMessage: (text) => setScmDraft(draftKey, text) });
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const findTitleSlot = useCallback((element: HTMLDivElement | null) => setTitleSlot(element?.closest('[data-group-body="side"]')?.parentElement?.querySelector<HTMLElement>(SCM_TITLE_SLOT) ?? null), []);
  const refreshKey = `${status.repoRoot}|${status.branch}|${status.lastCommit?.hash}|${status.ahead}|${status.behind}`;
  const nothing = status.staged.length + status.changes.length + status.conflicts.length === 0;
  useEffect(() => {
    if (status.operation === "merge" && status.mergeMessage && !message) setScmDraft(draftKey, status.mergeMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.operation, status.mergeMessage, draftKey]);
  const titleActions = <ScmTitleActions status={status} tree={tree} actions={actions} reload={reload} />;
  return (
    <div className="scm-view" aria-label={M.viewAria} ref={findTitleSlot}>
      {showTitle && (titleSlot ? createPortal(titleActions, titleSlot) : <div className="scm-head" role="toolbar" aria-label={S.scmTitleActionsAria}>{titleActions}</div>)}
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
      {!compact && (
        <div className="scm-dock">
          <ScmWorktrees currentRoot={status.repoRoot ?? ""} refreshKey={refreshKey} />
          <ScmGraph target={{ agentId: agentId ?? undefined, workspaceId }} refreshKey={refreshKey} />
        </div>
      )}
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

function CommitBox({ status, message, actions, onMessage }: { status: ScmStatus; message: string; actions: ScmActions; onMessage: (text: string) => void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const focusRequest = useStore((s) => s.focusScmMessage);
  useEffect(() => {
    if (focusRequest === null) return;
    if (Date.now() - focusRequest < 3000) field.current?.focus();
    setState({ focusScmMessage: null });
  }, [focusRequest]);
  const hasWork = hasWorkOf(status);
  const syncable = !hasWork && !!status.upstream && status.ahead + status.behind > 0;
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
