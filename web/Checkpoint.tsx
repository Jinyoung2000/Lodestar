import { createContext, useContext, useEffect, useState } from "react";
import { AddToBoardButton } from "./AddToBoardButton";
import type { CheckpointMode, RestorePlan, RestoreSkip, TimelineItem } from "../shared/protocol";
import { restoreToastText } from "./checkpointToast";
import { confirmAction } from "./ConfirmDialog";
import { checkAllDisks } from "./editorDocs";
import { reportSkipped } from "./fileActions";
import { Close, Fork, Undo } from "./icons";
import { rpc } from "./rpc";
import { flash, openAgent, refreshGit, setState } from "./store";
import { S } from "./strings";
import type { UserItem } from "./timelineModel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

export type TimelineContextValue = { agentId: string; paneId: string; busy: boolean; modes: Record<string, CheckpointMode>; revealAll: boolean; codex?: boolean; locked?: ReadonlySet<string>; workspaceId?: string | null; improvement?: boolean };
export const TimelineContext = createContext<TimelineContextValue>({ agentId: "", paneId: "", busy: false, modes: {}, revealAll: false });

export function useCheckpointModes(agentId: string, items: TimelineItem[] | undefined, busy: boolean) {
  const [modes, setModes] = useState<Record<string, CheckpointMode>>({});
  const unknown = !busy && !!items?.some((i) => i.kind === "user" && i.source !== "system" && !i.messageId && !i.preCompact && !modes[i.id]);
  useEffect(() => {
    if (!unknown || busy) return;
    let live = true;
    rpc.call("agents.checkpointModes", { agentId }).then(
      (next) => live && setModes((prev) => ({ ...prev, ...next })),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [agentId, unknown, busy]);
  return modes;
}

export function CheckpointActions({ user, first }: { user: UserItem; first: boolean }) {
  const { agentId, paneId, busy, modes } = useContext(TimelineContext);
  const [restoring, setRestoring] = useState(false);
  const [checking, setChecking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const mode = user.preCompact ? "none" : user.messageId ? "files" : (modes[user.id] ?? "pending");
  const restorable = (mode === "files" || mode === "chat") && !busy;
  const { label, tip: labelTip } = dividerText(mode, first, busy, user.preCompact === true);

  const start = async () => {
    if (mode !== "files") {
      void restore();
      return;
    }
    setChecking(true);
    try {
      const { plan } = await rpc.call("agents.previewCheckpoint", { agentId, itemId: user.id });
      if (plan && plan.revert.length + plan.remove.length + plan.skip.length > 0) {
        const ok = await confirmAction(first ? S.restoreConfirmTitleStartOver : S.restoreConfirmTitle, first ? S.startOverConfirm : S.discardEdits, restoreDetail(plan), "warning");
        if (ok) void restore();
      } else void restore();
    } catch {
      void restore();
    } finally {
      setChecking(false);
    }
  };

  const restore = async () => {
    setRestoring(true);
    try {
      const result = await rpc.call("agents.restoreCheckpoint", { agentId, itemId: user.id });
      setState((s) => ({ composerPrefill: { ...s.composerPrefill, [paneId]: { text: result.text, nonce: Date.now() } }, focusComposer: { paneId, nonce: Date.now() } }));
      flash(result.chatOnly ? S.chatRestoredToast : restoreToastText(result));
      reportRestoreSkipped(agentId, result.skipped);
      await refreshGit(agentId);
      checkAllDisks();
    } catch (error) {
      flash(S.checkpointFailed((error as Error).message));
    } finally {
      setRestoring(false);
    }
  };
  const fork = async () => {
    try {
      const agent = await rpc.call("agents.fork", { agentId, beforeItemId: user.id });
      openAgent(agent.id);
    } catch (error) {
      flash(S.forkFailed((error as Error).message));
    }
  };

  return (
    <div className="checkpoint-actions" data-pending={restoring || checking || undefined} data-open={menuOpen || undefined}>
      {restoring && first ? (
        <button type="button" className="checkpoint-button" aria-label={S.cancelStartOver} title={S.cancelStartOver} onClick={() => void rpc.call("agents.cancelRestore", { agentId })}>
          <Close size={12} />
        </button>
      ) : (
        <>
          {!!(user.shown ?? user.text).trim() && <AddToBoardButton agentId={agentId} itemId={user.id} text={user.shown ?? user.text} part={null} kind="message" className="checkpoint-button" size={12} />}
          {!first && (
            <button type="button" className="checkpoint-button" aria-label={S.forkFromHere} title={user.preCompact ? S.preCompactTip : S.forkFromHereTip} disabled={user.preCompact === true} data-action="fork-button" onClick={() => void fork()}>
              <Fork size={12} />
            </button>
          )}
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button type="button" className="checkpoint-button" aria-label={S.checkpointActionsAria} title={S.checkpointActionsAria} disabled={restoring || checking}>
                <Undo size={12} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-testid="checkpoint-menu">
              <DropdownMenuItem disabled={!restorable} title={labelTip} data-action="restore" onSelect={() => void start()}>
                {label}
              </DropdownMenuItem>
              {!first && (
                <DropdownMenuItem disabled={user.preCompact === true} title={user.preCompact ? S.preCompactTip : S.forkFromHereTip} data-action="fork" onSelect={() => void fork()}>
                  {S.forkFromHere}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}

export function RestoredMarker({ redoable, chatOnly = false }: { redoable: boolean; chatOnly?: boolean }) {
  const { agentId, paneId, busy } = useContext(TimelineContext);
  const redo = async () => {
    try {
      const result = await rpc.call("agents.redoCheckpoint", { agentId });
      setState((s) => ({ composerPrefill: { ...s.composerPrefill, [paneId]: { text: "", nonce: Date.now() } } }));
      flash(result.chatOnly ? S.chatReappliedToast : S.filesReapplied(result.files));
      reportRestoreSkipped(agentId, result.skipped);
      await refreshGit(agentId);
      checkAllDisks();
    } catch (error) {
      flash(S.checkpointFailed((error as Error).message));
    }
  };
  return (
    <div className="checkpoint-divider checkpoint-restored">
      <span className="checkpoint-rule" />
      <span className="checkpoint-label" title={chatOnly ? S.chatRestoredTip : undefined}>
        {chatOnly ? S.chatRestored : S.checkpointRestored}
      </span>
      <span className="checkpoint-dot" />
      <button type="button" className="checkpoint-action" disabled={!redoable || busy} title={chatOnly ? S.redoChatTip : S.redoTip} onClick={() => void redo()}>
        {S.redo}
      </button>
      <span className="checkpoint-rule" />
    </div>
  );
}

function dividerText(mode: CheckpointMode | "pending", first: boolean, busy: boolean, preCompact: boolean) {
  if (preCompact) return { label: first ? S.startOver : S.restoreCheckpoint, tip: S.preCompactTip };
  if (mode === "chat") {
    const label = first ? S.startOverChatOnly : S.restoreChatOnly;
    if (busy) return { label, tip: S.busyCheckpointTip };
    return { label, tip: first ? S.startOverChatOnlyTip : S.restoreChatOnlyTip };
  }
  const label = first ? S.startOver : S.restoreCheckpoint;
  if (busy) return { label, tip: S.busyCheckpointTip };
  if (mode === "none") return { label, tip: S.unmatchedCheckpointTip };
  if (mode === "pending") return { label, tip: S.checkingCheckpointTip };
  return { label, tip: first ? S.startOverTip : S.restoreCheckpointTip };
}

function restoreDetail(plan: RestorePlan) {
  const groups = [
    plan.revert.length > 0 ? `${S.restoreGroupRevert(plan.revert.length)}\n${S.undoFileList(plan.revert.map((f) => f.rel))}` : null,
    plan.remove.length > 0 ? `${S.restoreGroupTrash(plan.remove.length)}\n${S.undoFileList(plan.remove.map((f) => f.rel))}` : null,
    plan.skip.length > 0 ? `${S.restoreGroupSkip(plan.skip.length)}\n${S.undoFileList(plan.skip.map((f) => `${f.rel} (${S.restoreSkipReason(f.reason)})`))}` : null,
  ];
  return [plan.revert.length + plan.remove.length === 0 ? S.restoreNothingToChange : null, ...groups].filter((g) => g !== null).join("\n\n");
}

function reportRestoreSkipped(agentId: string, skipped: RestoreSkip[] | undefined) {
  if (!skipped || skipped.length === 0) return;
  reportSkipped(agentId, skipped, (path) => skipped.find((s) => s.path === path)?.rel ?? path);
}
