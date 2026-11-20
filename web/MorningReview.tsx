import { useEffect, useState } from "react";
import { REVIEW_SECTIONS, type MorningReview, type ReviewItem, type ReviewSection } from "../shared/morningReview";
import { Check, ChevronDown, ChevronRight, DotSpinner } from "./icons";
import { applyReviewMoves, markReviewSeen, moveStateOf, pendingMoveIds, reviewDayLabel, runReviewNow, setReviewOpen, useReviewOpen } from "./reviewActions";
import { Resizer } from "./Resizer";
import { rpc } from "./rpc";
import { boardFailed, openAgent, openCard, setLayout, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

// 끌어서 바꾸는 본문 높이의 아래 한계. 위 한계는 보드 높이의 70% (아래 열 영역이 남도록).
const REVIEW_MIN = 80;

// Board 맨 위의 접을 수 있는 Morning review 영역. 데몬이 만든 리뷰(최근 7일)를 섹션별로 보여 주고, 끝난 것 같은 카드의 이동 제안은 사용자가 Move 나 Apply all 을 눌러야만 적용한다.
// 데몬이 아직 리뷰를 모르는 옛 버전이면 review 상태가 없어서 영역 자체를 그리지 않는다.
export function MorningReviewPanel() {
  const state = useStore((s) => s.review);
  const board = useStore((s) => s.board);
  const reviewTime = useStore((s) => s.settings?.morningReviewTime ?? "09:30");
  const open = useReviewOpen();
  const height = useStore((s) => s.layout.reviewHeight);
  const [picked, setPicked] = useState<string | null>(null);
  const unreadDate = state?.unreadDate ?? null;

  // 안 읽은 자동 리뷰가 있을 때 이 영역이 화면에 있으면 봤다고 표시한다. 접혀 있었으면 펴서 보이게 한다. 창이 가려져 있으면 다시 보일 때 표시한다.
  useEffect(() => {
    if (!unreadDate) return;
    const seen = () => {
      if (document.visibilityState !== "visible") return;
      setReviewOpen(true);
      setPicked(null);
      markReviewSeen(unreadDate);
    };
    seen();
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  }, [unreadDate]);

  // 새 리뷰를 만들기 시작하면 날짜 선택을 풀어 결과(오늘 것)가 바로 보이게 한다
  const running = state?.running ?? false;
  useEffect(() => {
    if (running) setPicked(null);
  }, [running]);

  if (!state) return null;
  const current = state.reviews.find((r) => r.date === picked) ?? state.reviews[0] ?? null;
  const pending = current ? pendingMoveIds(current, board) : [];

  return (
    <>
    <section className="review" aria-label={S.reviewTitle} data-open={open ? "" : undefined}>
      <div className="review-head">
        <Button size="icon" aria-expanded={open} aria-label={open ? S.reviewCollapse : S.reviewExpand} onClick={() => setReviewOpen(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </Button>
        <span className="agent-title review-title">{S.reviewTitle}</span>
        {state.running && (
          <span className="review-running faint xs" role="status">
            <DotSpinner state="running" /> {S.reviewRunning}
          </span>
        )}
        {!state.running && current && !current.empty && <span className="faint xs review-summary-line">{current.summary}</span>}
        <span className="spacer" />
        {state.reviews.length > 1 && current && (
          <Select value={current.date} onValueChange={setPicked}>
            <SelectTrigger aria-label={S.reviewPickDate} title={S.reviewPickDate}>
              <SelectValue>{reviewDayLabel(current.date)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {state.reviews.map((r) => (
                <SelectItem key={r.date} value={r.date}>
                  {reviewDayLabel(r.date)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {current && state.reviews.length === 1 && <span className="faint xs">{reviewDayLabel(current.date)}</span>}
        {current && pending.length > 0 && (
          <Button variant="secondary" size="sm" title={S.reviewApplyAllTip} onClick={() => void applyReviewMoves(current.date, null)}>
            {S.reviewApplyAll(pending.length)}
          </Button>
        )}
      </div>
      {open && (
        <div className="review-body" style={height == null ? undefined : { height, maxHeight: "none" }}>
          {state.error && (
            <div className="review-notice" role="alert" data-tone="error">
              <span className="review-notice-text">{state.error}</span>
              <Button variant="secondary" size="sm" disabled={state.running} onClick={() => void runReviewNow()}>
                {S.reviewRetry}
              </Button>
            </div>
          )}
          {!current && !state.running && !state.error && <div className="review-notice faint">{S.reviewIdle(reviewTime)}</div>}
          {current?.empty && <div className="review-notice faint">{current.empty === "noCards" ? S.reviewEmptyNoCards : S.reviewEmptyAllDone}</div>}
          {current && !current.empty && current.summary && <p className="review-summary">{current.summary}</p>}
          {current && !current.empty && <ReviewSections review={current} />}
        </div>
      )}
    </section>
    {open && <Resizer axis="y" label={S.resizeReview} target=".review-body" direction={1} min={REVIEW_MIN} max={() => (document.querySelector(".board")?.getBoundingClientRect().height ?? 0) * 0.7} onSize={(px) => setLayout({ reviewHeight: px })} />}
    </>
  );
}

function ReviewSections({ review }: { review: MorningReview }) {
  const shown = REVIEW_SECTIONS.filter((section) => review.items[section].length > 0);
  if (shown.length === 0) return <div className="review-notice faint">{S.reviewNothing}</div>;
  return (
    <div className="review-sections">
      {shown.map((section) => (
        <section key={section} className="review-section" aria-label={S.reviewSections[section]}>
          <div className="review-section-head">
            <span className="agent-title">{S.reviewSections[section]}</span>
            <span className="faint xs">{review.items[section].length}</span>
          </div>
          <ul className="review-list">
            {review.items[section].map((item) => (
              <ReviewRow key={`${item.cardId}:${item.agentId}`} review={review} section={section} item={item} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// 항목 하나. 세션 중심 섹션(waiting, unboarded)은 세션을, 카드 중심 섹션은 카드를 연다. 지금 이름이 있으면 그것을 쓰고, 지워졌으면 만들 때의 이름을 눌러지지 않게 보인다.
function ReviewRow({ review, section, item }: { review: MorningReview; section: ReviewSection; item: ReviewItem }) {
  const board = useStore((s) => s.board);
  const card = useStore((s) => (item.cardId ? s.board?.cards.find((c) => c.id === item.cardId) : undefined));
  const agent = useStore((s) => (item.agentId ? s.agents.find((a) => a.id === item.agentId) : undefined));
  const bySession = item.agentId !== null;
  const title = (bySession ? agent?.title : card?.title) ?? item.title;
  const exists = bySession ? !!agent : !!card;
  const move = item.move;
  const moveState = moveStateOf(item, board);
  const target = board?.columns.find((c) => c.id === move?.toColumnId);
  // 카드가 지금 있는 열 (카드가 지워졌으면 만들 때의 열 이름)
  const columnName = (card ? board?.columns.find((c) => c.id === card.columnId)?.name : item.column) ?? null;

  return (
    <li className="review-row">
      <div className="review-row-top">
        {exists ? (
          <button type="button" className="review-link" title={bySession ? S.reviewOpenSession : S.reviewOpenCard} onClick={() => (bySession ? openAgent(item.agentId!) : openCard(item.cardId!))}>
            {title}
          </button>
        ) : (
          <span className="review-link" data-gone="" title={S.reviewGone}>
            {title}
          </span>
        )}
        {section === "stale" && item.idleDays !== undefined && <span className="faint xs review-tag">{S.reviewIdleDays(item.idleDays)}</span>}
        {card && board ? (
          <Select value={card.columnId} onValueChange={(columnId) => void rpc.call("board.moveCard", { id: card.id, columnId, index: Number.MAX_SAFE_INTEGER }).catch(boardFailed)}>
            <SelectTrigger className="review-status" aria-label={S.reviewChangeStatus} title={S.reviewChangeStatus}>
              <SelectValue>{columnName}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {board.columns.map((column) => (
                <SelectItem key={column.id} value={column.id}>
                  {column.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          section !== "stale" && columnName && <span className="faint xs review-tag">{columnName}</span>
        )}
      </div>
      <div className="review-note">{item.note}</div>
      {move && moveState === "pending" && (
        <div className="review-row-actions">
          <Button variant="secondary" size="sm" onClick={() => void applyReviewMoves(review.date, [item.cardId!])}>
            {S.reviewMove(target?.name ?? move.toColumnName)}
          </Button>
        </div>
      )}
      {move && moveState === "done" && (
        <div className="review-row-actions review-moved faint xs">
          <Check size={12} /> {S.reviewMoved(target?.name ?? move.toColumnName)}
        </div>
      )}
    </li>
  );
}
