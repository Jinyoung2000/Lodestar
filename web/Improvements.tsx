import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Agent, Feedback } from "../shared/protocol";
import { canRetryChecks } from "../shared/feedbackRetry";
import { canRunAgain } from "../shared/feedbackResume";
import { feedbackBadge, type FeedbackBadge } from "./feedbackBadge";
import { reloadWindow } from "./reload";
import { replyToFeedback, restartFeedback, retryAllNotApplied, revertFeedback, tidyFeedback, useRetryAll } from "./feedbackActions";
import { retryFeedbackChecks, retryLabel, runFeedbackAgain } from "./FeedbackRetry";
import { shortTime } from "./Inbox";
import { neighborRowId } from "./inboxRows";
import { canTidy, improvementRows, requestFirstLine, retryTargets, type ImprovementFilter } from "./improvementRows";
import { Codicon, Refresh, Start, Trash, Undo } from "./icons";
import { deleteSession } from "./sessionActions";
import { SplitDetail } from "./SplitDetail";
import { closeImprovement, openAgent, openImprovement, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

// 가운데 영역에 세션 격자 대신 보이는 Improvements. Lodestar 가 사용자의 피드백으로 연 개선 세션을 최신순으로 보이고, 행을 누르면 이 화면 안의 오른쪽 상세 칸에 열린다(세션 오른쪽 패널은 쓰지 않는다).
// 이 세션들은 Sessions 목록에 없다. 세션이 아직 있는 피드백만 나오고, 세션을 지우면 기록은 되돌리기 백업으로 남은 채 이 목록에서 빠진다.
export function ImprovementsView() {
  const feedbacks = useStore((s) => s.feedbacks);
  const agents = useStore((s) => s.agents);
  const selectedId = useStore((s) => s.selectedFeedbackId);
  const [filter, setFilter] = useState<ImprovementFilter>("all");
  const listRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);

  const rows = useMemo(() => improvementRows(feedbacks, agents, filter, selectedId), [feedbacks, agents, filter, selectedId]);
  const retryable = useMemo(() => retryTargets(feedbacks, agents).length, [feedbacks, agents]);
  const retrying = useRetryAll();
  // 세션을 지워서 목록에서 빠진 항목은 상세도 비운다.
  const open = rows.find((f) => f.id === selectedId) ?? null;

  // 필터를 바꿀 때 열린 항목이 새 필터에 안 맞으면 목록에서 빠지므로 상세도 닫는다.
  const changeFilter = (next: ImprovementFilter) => {
    setFilter(next);
    if (open && !improvementRows({ [open.id]: open }, agents, next, null).length) closeImprovement();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!(event.target as HTMLElement).classList.contains("inbox-row")) return;
    event.preventDefault();
    const next = neighborRowId(rows, open?.id ?? null, event.key === "ArrowDown" ? 1 : -1);
    if (!next) return;
    focusAfter.current = next;
    openImprovement(next);
  };
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-feedback-id="${CSS.escape(id)}"]`)?.focus();
  }, [rows]);

  const empty = filter === "notApplied" ? S.improvementsEmptyNotApplied : filter === "applied" ? S.improvementsEmptyApplied : filter === "dismissed" ? S.improvementsEmptyDismissed : S.improvementsEmpty;

  return (
    <div className="split-view">
      <section className="inbox" aria-label={S.improvements}>
        <div className="pane-header">
          <span className="agent-title board-header-title">{S.improvements}</span>
          <Select value={filter} onValueChange={(v) => changeFilter(v as ImprovementFilter)}>
            <SelectTrigger aria-label={S.improvementsFilter} title={S.improvementsFilter}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{S.improvementsShowAll}</SelectItem>
              <SelectItem value="notApplied">{S.improvementsShowNotApplied}</SelectItem>
              <SelectItem value="applied">{S.improvementsShowApplied}</SelectItem>
              <SelectItem value="dismissed">{S.improvementsShowDismissed}</SelectItem>
            </SelectContent>
          </Select>
          <span className="spacer" />
          <Button size="sm" aria-label={S.improvementsRetryAll} title={S.improvementsRetryAllTip} disabled={retryable === 0 || retrying !== null} onClick={() => void retryAllNotApplied()}>
            <span className={retrying ? "spin" : undefined}>
              <Refresh size={14} />
            </span>
            <span className="inbox-markall-label">{retrying ? S.improvementsRetryProgress(retrying.done, retrying.total) : S.improvementsRetryAll}</span>
          </Button>
        </div>
        <div className="inbox-list" role="list" aria-label={S.improvementsList} ref={listRef} onKeyDown={onListKeyDown}>
          {rows.length === 0 && <div className="empty-hint">{empty}</div>}
          {rows.map((feedback) => (
            <ImprovementRow key={feedback.id} feedback={feedback} selected={feedback.id === open?.id} />
          ))}
        </div>
      </section>
      <SplitDetail widthKey="improvementsDetailWidth" label={S.improvementsDetailAria} title={S.improvementsDetail} closeLabel={S.improvementsClose} onClose={open ? closeImprovement : null}>
        <ImprovementDetail feedback={open} />
      </SplitDetail>
    </div>
  );
}

function ImprovementRow({ feedback, selected }: { feedback: Feedback; selected: boolean }) {
  const files = feedback.changedFiles.length;
  // FBREDO: 반영 안 됨 행의 우클릭 메뉴(Mark as Resolved, Dismiss)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const tidyable = canTidy(feedback);
  return (
    <div role="listitem" className="inbox-item">
      {menu && tidyable && (
        <DropdownMenu open onOpenChange={(open) => !open && setMenu(null)}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="menu-anchor" style={{ left: menu.x, top: menu.y }} tabIndex={-1} aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" aria-label={S.improvementsRowMenu} data-testid="improvement-row-menu" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuItem title={S.feedbackResolveTip} data-action="resolve" onSelect={() => void tidyFeedback(feedback, "resolve")}>
              {S.feedbackResolve}
            </DropdownMenuItem>
            <DropdownMenuItem title={S.feedbackDismissTip} data-action="dismiss" onSelect={() => void tidyFeedback(feedback, "dismiss")}>
              {S.feedbackDismiss}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button
        type="button"
        className="inbox-row"
        data-feedback-id={feedback.id}
        data-feedback-status={feedback.status}
        data-selected={selected || undefined}
        onClick={() => openImprovement(feedback.id)}
        onContextMenu={(e) => {
          if (!tidyable) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <span className="inbox-main">
          <span className="inbox-head">
            <ImprovementState feedback={feedback} />
            <span className="spacer" />
            {files > 0 && <span className="faint xs">{S.improvementsFiles(files)}</span>}
            <span className="faint xs" title={new Date(feedback.updatedAt).toLocaleString()}>
              {shortTime(feedback.updatedAt)}
            </span>
          </span>
          <span className="inbox-line">{requestFirstLine(feedback.text)}</span>
        </span>
      </button>
    </div>
  );
}

// 상태 라벨. 개선 세션이 도는 중(running)은 상태 배지가 없어서 같은 모양의 작업 중 라벨을 쓴다.
function ImprovementState({ feedback }: { feedback: Pick<Feedback, "status" | "retrying" | "restartPending" | "failure"> & Partial<Pick<Feedback, "blocked">> }) {
  const badge = feedbackBadge(feedback);
  if (!badge) {
    return <StateLabel badge={{ status: "running", label: S.feedbackStatus.running, tone: "info", icon: "sync", spin: true }} />;
  }
  return <StateLabel badge={badge} />;
}

function StateLabel({ badge }: { badge: FeedbackBadge }) {
  return (
    <span className="feedback-state" data-tone={badge.tone} data-status={badge.status}>
      <Codicon name={badge.icon} size={12} spin={badge.spin} />
      <span>{badge.label}</span>
    </span>
  );
}

function ImprovementDetail({ feedback }: { feedback: Feedback | null }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === feedback?.agentId));
  if (!feedback || !agent) return <div className="empty-hint">{S.improvementsPick}</div>;
  return <ImprovementForm key={feedback.id} feedback={feedback} agent={agent} />;
}

// 상태, 실패 이유 전문, 바뀐 파일, 동작 버튼. Revert 와 Retry 는 사이드바 행 메뉴와 알림에 있던 것과 같은 동작이다.
function ImprovementForm({ feedback, agent }: { feedback: Feedback; agent: Agent }) {
  const [busy, setBusy] = useState(false);
  const needsReply = feedback.status === "needsInput";
  const canRevert = feedback.status === "applied";
  const canRestart = (feedback.status === "awaitingRestart" || feedback.restartPending) && !feedback.restartRequested;
  // 웹 변경이 반영된 뒤에는 창을 다시 읽어야 보인다(데몬 변경은 Restart Daemon 이 창까지 다시 읽는다).
  const canReload = feedback.status === "applied" && !feedback.needsRestart;
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };

  return (
    <div className="card-detail" aria-label={S.improvementsDetailAria} data-feedback-id={feedback.id}>
      <div className="card-detail-body">
        <div className="inbox-detail-head">
          <span className="card-title">{requestFirstLine(feedback.text)}</span>
          <span className="faint xs" title={new Date(feedback.updatedAt).toLocaleString()}>
            {shortTime(feedback.updatedAt)}
          </span>
        </div>

        <div className="card-detail-section">
          <div className="section-label">{S.improvementsStatus}</div>
          <div>
            <ImprovementState feedback={feedback} />
          </div>
          {feedback.summary && !needsReply && <div className="inbox-text">{feedback.summary}</div>}
        </div>

        {needsReply && feedback.question && (
          <div className="card-detail-section">
            <div className="section-label">{S.improvementsQuestion}</div>
            <div className="inbox-text" data-testid="improvement-question">
              {feedback.question}
            </div>
          </div>
        )}

        {(feedback.failure || feedback.status === "blocked") && (
          <div className="card-detail-section">
            <div className="section-label">{feedback.status === "blocked" ? S.improvementsWaiting : S.improvementsReason}</div>
            <div className="inbox-text mono small muted" data-testid="improvement-failure">
              {feedback.failure ?? S.feedbackBlocked[feedback.blocked?.reason ?? "environment"]}
            </div>
            {feedback.blocked?.nextRetryAt && (
              <div className="faint xs" data-testid="improvement-next-try">
                {S.improvementsNextTry(shortTime(feedback.blocked.nextRetryAt))}
              </div>
            )}
          </div>
        )}

        {feedback.text.trim() !== requestFirstLine(feedback.text) && (
          <div className="card-detail-section">
            <div className="section-label">{S.improvementsRequest}</div>
            <div className="inbox-text">{feedback.text}</div>
          </div>
        )}

        <div className="card-detail-section">
          <div className="section-label">{S.improvementsChanged}</div>
          {feedback.changedFiles.length === 0 && <div className="muted small">{S.improvementsNoFiles}</div>}
          {feedback.changedFiles.map((path) => (
            <div key={path} className="mono small truncate" title={path}>
              {path}
            </div>
          ))}
        </div>

        <div className="card-detail-actions">
          {needsReply && (
            <Button variant="primary" size="sm" onClick={() => replyToFeedback(agent.id)}>
              <Codicon name="comment" size={14} /> {S.improvementsReply}
            </Button>
          )}
          <Button variant={needsReply ? undefined : "primary"} size="sm" onClick={() => openAgent(agent.id)}>
            <Start size={14} /> {S.improvementsOpenSession}
          </Button>
          {canRetryChecks(feedback) && (
            <Button size="sm" onClick={() => void retryFeedbackChecks(feedback)}>
              <Refresh size={14} /> {retryLabel(feedback)}
            </Button>
          )}
          {canTidy(feedback) && (
            <>
              <Button size="sm" title={S.feedbackResolveTip} disabled={busy} onClick={() => run(() => tidyFeedback(feedback, "resolve"))}>
                <Codicon name="pass" size={14} /> {S.feedbackResolve}
              </Button>
              <Button size="sm" title={S.feedbackDismissTip} disabled={busy} onClick={() => run(() => tidyFeedback(feedback, "dismiss"))}>
                <Codicon name="close" size={14} /> {S.feedbackDismiss}
              </Button>
            </>
          )}
          {canRunAgain(feedback) && (
            <Button size="sm" disabled={busy} onClick={() => run(() => runFeedbackAgain(feedback))}>
              <Refresh size={14} /> {S.feedbackRunAgain}
            </Button>
          )}
          {feedback.retrying && (
            <Button size="sm" disabled>
              <Refresh size={14} /> {S.feedbackRetrying}
            </Button>
          )}
          {canReload && (
            <Button size="sm" onClick={() => void reloadWindow()}>
              <Refresh size={14} /> {S.feedbackReload}
            </Button>
          )}
          {canRevert && (
            <Button size="sm" disabled={busy} onClick={() => run(() => revertFeedback(feedback))}>
              <Undo size={14} /> {S.feedbackRevert}
            </Button>
          )}
          {canRestart && (
            <Button size="sm" onClick={() => void restartFeedback(feedback)}>
              <Refresh size={14} /> {S.feedbackRestart}
            </Button>
          )}
          <Button size="sm" onClick={() => void deleteSession(agent)}>
            <Trash size={14} /> {S.improvementsDelete}
          </Button>
        </div>
      </div>
    </div>
  );
}
