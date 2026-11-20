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

// 타임라인 안쪽 컴포넌트가 칸과 세션을 알아야 한다(체크포인트 복원이 그 칸의 입력창을 채운다).
// modes 는 messageId 가 없는 사용자 항목(체크포인트 이전에 보낸 메시지)의 복원 범위. 서버에 물어 온 것만 있다.
// revealAll 이 true 면 접힌 단계 묶음도 안쪽 줄을 만든다(찾기가 열렸거나 메시지로 이동하려고 요청했을 때, web/timelineReveal.ts).
// codex 는 Codex 세션이라는 표지: 체크포인트 복원과 갈래 단추를 그리지 않는다.
// workspaceId, improvement 는 대화 위(AgentView)에서 한 번만 구해 내려 준다. 행마다 useStore 로 s.agents.find 를 돌리면 다른 세션의 스트리밍 이벤트 하나에도 행 수 × 세션 수만큼 훑는다(PERF2).
export type TimelineContextValue = { agentId: string; paneId: string; busy: boolean; modes: Record<string, CheckpointMode>; revealAll: boolean; codex?: boolean; workspaceId?: string | null; improvement?: boolean };
export const TimelineContext = createContext<TimelineContextValue>({ agentId: "", paneId: "", busy: false, modes: {}, revealAll: false });

// 응답 중이 아닐 때, 아직 범위를 모르는 옛 메시지가 있으면 서버에 한 번 묻는다. 실패하면 그 메시지는 알 수 없음(복원 버튼 비활성)으로 둔다.
export function useCheckpointModes(agentId: string, items: TimelineItem[] | undefined, busy: boolean) {
  const [modes, setModes] = useState<Record<string, CheckpointMode>>({});
  // 응답 중에는 묻지 않으므로 훑지도 않는다. 스트리밍 이벤트마다 긴 대화 전체를 훑던 비용이다(PERF2).
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

// 사용자 메시지의 체크포인트 동작(B2-04, FBREDO 개정). 줄을 차지하지 않는다: 말풍선 오른쪽 위 모서리의 작은 둥근 단추이고, 평소엔 투명하다가 말풍선에 마우스를 올리면 나타난다(Claude Code 의 Message actions 와 같다).
// 단추를 누르면 메뉴가 열린다. 첫 메시지는 Start Over(대화와 변경을 전부 지움, 갈래 없음), 그 뒤 메시지는 Restore Checkpoint 와 Fork from here.
export function CheckpointActions({ user, first }: { user: UserItem; first: boolean }) {
  const { agentId, paneId, busy, modes } = useContext(TimelineContext);
  const [restoring, setRestoring] = useState(false);
  // 파일 편집을 버리는 복원은 어떤 파일이 어떻게 되는지 보이는 확인 창을 거친다. 파일을 세는 동안 checking.
  const [checking, setChecking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // 압축 이전 메시지는 읽기 전용이라 복원과 갈래가 없다(세션 줄기에서 이어 가는 위치를 정할 수 없다)
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
      // 미리 세지 못해도 복원 자체가 같은 사유로 실패하면 거기서 알린다. 서버가 파일마다 다시 검사하므로 건너뛸 파일은 어느 쪽이든 지켜진다.
      void restore();
    } finally {
      setChecking(false);
    }
  };

  const restore = async () => {
    setRestoring(true);
    try {
      const result = await rpc.call("agents.restoreCheckpoint", { agentId, itemId: user.id });
      // 되돌린 메시지의 글을 입력창에 다시 채워서 고쳐 보낼 수 있게 한다.
      setState((s) => ({ composerPrefill: { ...s.composerPrefill, [paneId]: { text: result.text, nonce: Date.now() } }, focusComposer: { paneId, nonce: Date.now() } }));
      flash(result.chatOnly ? S.chatRestoredToast : restoreToastText(result));
      reportRestoreSkipped(agentId, result.skipped);
      await refreshGit(agentId);
      // FIX6C: 되돌린 파일을 열어 둔 편집기 탭을 디스크와 맞춘다(고치지 않은 탭은 다시 읽고, 고친 탭은 File changed on disk 안내)
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
          {/* fork 가 메뉴 안에만 있으면 찾기 어렵다(사용자 10-16 "fork 기능 어디갔냐"). 되돌리기 단추 옆에 바로 둔다.
              응답 중에도 갈라진다(사용자 10-29): 갈래는 원 세션을 이 메시지 앞 지점(resumeAt)에서 새 세션으로 가르고 원 세션은 건드리지 않는다. 되돌리기만 응답 중에 막는다. */}
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

// 복원한 자리(B2-05). Redo 는 복원 전의 파일과 대화를 되살린다. chatOnly 복원은 파일을 건드리지 않았으니 Redo 도 대화만 되살린다.
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

// 구분선 버튼의 문구와 툴팁. pending 은 서버가 아직 스냅샷 유무를 알려 주지 않은 옛 메시지다.
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

// 확인 창 본문: 되돌릴 파일, 휴지통으로 갈 파일, 건너뛸 파일을 이름으로 나눠 보인다(되돌릴 것이 없으면 그렇다고 말한다).
function restoreDetail(plan: RestorePlan) {
  const groups = [
    plan.revert.length > 0 ? `${S.restoreGroupRevert(plan.revert.length)}\n${S.undoFileList(plan.revert.map((f) => f.rel))}` : null,
    plan.remove.length > 0 ? `${S.restoreGroupTrash(plan.remove.length)}\n${S.undoFileList(plan.remove.map((f) => f.rel))}` : null,
    plan.skip.length > 0 ? `${S.restoreGroupSkip(plan.skip.length)}\n${S.undoFileList(plan.skip.map((f) => `${f.rel} (${S.restoreSkipReason(f.reason)})`))}` : null,
  ];
  return [plan.revert.length + plan.remove.length === 0 ? S.restoreNothingToChange : null, ...groups].filter((g) => g !== null).join("\n\n");
}

// 복원이나 Redo 가 건드리지 않은 파일을 경고 알림으로 알린다(4회차 Undo 와 같은 알림).
function reportRestoreSkipped(agentId: string, skipped: RestoreSkip[] | undefined) {
  if (!skipped || skipped.length === 0) return;
  reportSkipped(agentId, skipped, (path) => skipped.find((s) => s.path === path)?.rel ?? path);
}
