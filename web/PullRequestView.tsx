import "./pr.css";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { anchorKey, resolveFocus } from "../shared/prUrl";
import { isGeneratedPath } from "../shared/generatedFiles";
import { PrCommits } from "./PrCommits";
import { PrFiles } from "./PrFiles";
import { PrOverview } from "./PrOverview";
import { PrReview } from "./PrReview";
import { CheckIcon, checkKindOf, PrAvatar, PrStateIcon, ReviewIcon, reviewLabel, useNow } from "./PrBits";
import { Codicon, Refresh } from "./icons";
import { CENTER, closePr, ensureTabView, PrViewContext, refKey, usePr, usePrActions, usePrView, type PrRef } from "./prStore";
import { P } from "./prStrings";
import { relativeTime } from "./sessionList";
import type { PrViewTab } from "./store";
import { Button } from "./ui/button";

// 가운데에 열리는 PR 화면(사이드바 목록에서 연 것). 열린 PR 이 없으면 아무것도 그리지 않는다.
export function PullRequestView() {
  const ref = usePr((s) => s.views[CENTER]?.ref ?? null);
  const scope = useMemo(() => ({ id: CENTER, ref }), [ref]);
  if (!ref) return null;
  return (
    <PrViewContext.Provider value={scope}>
      <PrScreen inTab={false} active />
    </PrViewContext.Provider>
  );
}

// 에디터 칸의 탭으로 열리는 PR 화면(대화 속 링크에서 연 것). 같은 화면 컴포넌트를 쓰고, 탭 키로 자기 자리의 상태를 갖는다.
export function PullRequestTab({ tab, active }: { tab: PrViewTab; active: boolean }) {
  const ref = useMemo<PrRef>(() => ({ repo: tab.repo, number: tab.number }), [tab.repo, tab.number]);
  const scope = useMemo(() => ({ id: tab.key, ref }), [tab.key, ref]);
  // 창을 다시 읽어 복원된 탭은 상태가 비어 있다
  useEffect(() => ensureTabView(tab.key, ref), [tab.key, ref]);
  return (
    <PrViewContext.Provider value={scope}>
      <PrScreen inTab active={active} />
    </PrViewContext.Provider>
  );
}

// 머리(제목, 상태, 브랜치, 동작), Overview, Commits, Files Changed 탭. 가운데에 있을 때만 머리에 "세션으로 돌아가기" 가 있다(탭은 탭의 닫기 버튼이 있다).
// 에디터 칸의 탭 본문은 활성이 아니어도 마운트된 채 남으므로 active 가 아니면 숨긴다(상태와 스크롤은 그대로).
function PrScreen({ inTab, active }: { inTab: boolean; active: boolean }) {
  const open = usePrView((v) => v.ref);
  const detail = usePrView((v) => v.detail);
  const error = usePrView((v) => v.detailError);
  const loading = usePrView((v) => v.detailLoading);
  const tab = usePrView((v) => v.tab);
  // 생성 파일은 Files Changed 목록에서 빠지므로 수도 같이 뺀다. 목록을 읽기 전에는 GitHub 가 준 전체 수다.
  const fileCount = usePrView((v) => v.files?.filter((f) => !isGeneratedPath(f.path)).length ?? v.detail?.changedFiles ?? 0);
  const commitCount = usePrView((v) => v.detail?.commitCount ?? 0);
  const busy = usePrView((v) => v.busy);
  const actions = usePrActions();
  const body = useRef<HTMLDivElement>(null);
  const now = useNow();
  useAnchorFocus(body);

  // 창을 다시 읽은 뒤에는 열린 PR 의 내용이 비어 있다
  useEffect(() => {
    if (open && !detail && !loading && !error) void actions.reload();
  }, [open, detail, loading, error, actions]);

  if (!open) return null;
  return (
    <section className="pr-view" hidden={!active} aria-label={detail ? `#${detail.number} ${detail.title}` : P.section}>
      <header className="pr-view-head">
        <div className="pr-view-title-line">
          {!inTab && (
            <Button size="icon" aria-label="Close" title="Back to sessions" onClick={closePr}>
              <Codicon name="arrow-left" />
            </Button>
          )}
          {detail && <PrStateIcon pr={detail} />}
          <h2 className="pr-view-title" title={detail?.title}>
            {detail?.title ?? `${open.repo} #${open.number}`}
          </h2>
          <span className="pr-view-number">#{open.number}</span>
        </div>
        {detail && (
          <div className="pr-view-meta-line">
            <span className="pr-pill" data-state={detail.state === "OPEN" && detail.isDraft ? "DRAFT" : detail.state}>
              {detail.state === "MERGED" ? P.merged : detail.state === "CLOSED" ? P.closed : detail.isDraft ? P.draft : P.open}
            </span>
            <PrAvatar user={detail.author} size={16} />
            <span>{detail.author?.login}</span>
            <span className="pr-faint">{P.baseHead(detail.baseRef, detail.headRef)}</span>
            <span className="pr-faint" title={detail.updatedAt}>
              {relativeTime(detail.updatedAt, now)}
            </span>
            {checkKindOf(detail.checks) && <CheckIcon kind={checkKindOf(detail.checks) ?? "neutral"} />}
            {reviewLabel(detail.reviewDecision) && (
              <span className="pr-meta-review">
                <ReviewIcon decision={detail.reviewDecision} />
                {reviewLabel(detail.reviewDecision)}
              </span>
            )}
            <span className="spacer" />
            <span className="pr-stat" data-kind="add">
              +{detail.additions}
            </span>
            <span className="pr-stat" data-kind="del">
              -{detail.deletions}
            </span>
          </div>
        )}
        <div className="pr-view-actions">
          <div className="pr-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "overview"} data-active={tab === "overview" || undefined} onClick={() => actions.selectTab("overview")}>
              {P.overview}
            </button>
            <button type="button" role="tab" aria-selected={tab === "commits"} data-active={tab === "commits" || undefined} onClick={() => actions.selectTab("commits")}>
              {P.commits}
              <span className="pr-count" data-quiet="">
                {commitCount}
              </span>
            </button>
            <button type="button" role="tab" aria-selected={tab === "files"} data-active={tab === "files" || undefined} onClick={() => actions.selectTab("files")}>
              {P.filesChanged}
              <span className="pr-count" data-quiet="">
                {fileCount}
              </span>
            </button>
          </div>
          <span className="spacer" />
          <Button size="icon" aria-label={P.refresh} title={P.refresh} onClick={() => void actions.reload(true)}>
            <Refresh className={loading ? "pr-spin" : undefined} />
          </Button>
          {detail && (
            <Button variant="secondary" onClick={() => window.open(detail.url, "_blank", "noreferrer")}>
              <Codicon name="link-external" size={14} />
              {P.openOnGithub}
            </Button>
          )}
          {detail && (
            <Button variant="secondary" disabled={busy !== null} onClick={() => void actions.checkout()}>
              <Codicon name="git-branch" size={14} />
              {busy === "checkout" ? P.checkoutBusy : P.checkout}
            </Button>
          )}
          {detail && (
            <Button variant="secondary" disabled={busy !== null} title={P.reviewWithClaudeTitle} onClick={() => void actions.reviewWithClaude()}>
              <Codicon name="claude" size={14} />
              {P.reviewWithClaude}
            </Button>
          )}
          <PrReview />
        </div>
      </header>
      {/* PR 마다 새로 만든다. 가운데 화면에서 다른 PR 을 열면 앞 PR 의 머지 확인 단계와 입력 중인 코멘트가 새 PR 에 남지 않게 */}
      <div className="pr-view-body" ref={body} key={refKey(open)}>
        {error && <div className="pr-empty">{error}</div>}
        {!error && !detail && <div className="pr-empty">{P.loading}</div>}
        {detail && tab === "overview" && <PrOverview detail={detail} />}
        {detail && tab === "commits" && <PrCommits />}
        {detail && tab === "files" && <PrFiles />}
      </div>
    </section>
  );
}

// 주소의 #앵커(코멘트, 리뷰, 체크)로 열렸으면 상세가 도착한 뒤 그 대상이 있는 탭과 파일로 옮기고, 요소가 그려지면 가운데로 스크롤해 잠깐 강조한다.
// 대상이 없으면(지워졌거나 100개 한도 밖) 조용히 멈춘다. smooth 는 스크롤 컨테이너 안에서 조용히 취소되므로 쓰지 않는다.
function useAnchorFocus(body: RefObject<HTMLElement | null>) {
  const focus = usePrView((v) => v.focus);
  const detail = usePrView((v) => v.detail);
  const tab = usePrView((v) => v.tab);
  const selectedFile = usePrView((v) => v.selectedFile);
  const files = usePrView((v) => v.files);
  const actions = usePrActions();

  useEffect(() => {
    if (!focus || !detail) return;
    const target = resolveFocus(detail, focus);
    if (!target) {
      actions.clearFocus();
      return;
    }
    if (target.tab !== tab || (target.file !== null && target.file !== selectedFile)) actions.showFocus(target.tab, target.file);
    // 앵커가 오면 한 번만 옮긴다(그 뒤 사용자가 탭을 바꿔도 되돌리지 않는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, detail]);

  useEffect(() => {
    if (!focus || !detail) return;
    const target = resolveFocus(detail, focus);
    if (!target) return;
    const there = tab === target.tab && (target.file === null || (selectedFile === target.file && files !== null));
    if (!there) return;
    // 해결된 스레드는 이 렌더 뒤의 effect 에서 펼쳐지므로 요소가 조금 늦게 생긴다
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const find = () => {
      const element = body.current?.querySelector<HTMLElement>(`[data-pr-anchor="${anchorKey(focus)}"]`);
      if (!element && tries++ < 30) {
        timer = setTimeout(find, 30);
        return;
      }
      if (element) {
        element.scrollIntoView({ block: "center", behavior: "instant" });
        element.setAttribute("data-pr-flash", "");
        setTimeout(() => element.removeAttribute("data-pr-flash"), 1800);
      }
      actions.clearFocus();
    };
    find();
    return () => clearTimeout(timer);
  }, [focus, detail, tab, selectedFile, files, actions, body]);
}
