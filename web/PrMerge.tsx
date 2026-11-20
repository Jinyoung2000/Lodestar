import { useEffect, useRef, useState } from "react";
import { checksSummary, defaultMergeMethod, MERGE_METHODS, mergeArea, requiredReviewSummary, type MergeReadiness } from "../shared/prMerge";
import type { PrCheck, PrDetail, PrMergeMethod, PrRequiredReviews } from "../shared/prTypes";
import { CheckIcon, checkKindOf, type CheckKind } from "./PrBits";
import { Codicon } from "./icons";
import { sortChecks } from "./prChecks";
import { usePr, usePrActions, usePrView } from "./prStore";
import { P } from "./prStrings";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function PrMerge({ detail }: { detail: PrDetail }) {
  const area = mergeArea(detail);
  useMergeabilityPoll(area.state === "open" && area.readiness === "unknown");
  return (
    <section className="pr-merge" aria-label={P.mergeSection} data-state={area.state}>
      {area.state === "merged" && (
        <div className="pr-merge-item">
          <span className="pr-merge-icon" data-kind="merged">
            <Codicon name="git-merge" size={16} />
          </span>
          <p>{P.prMerged}</p>
        </div>
      )}
      {area.state === "closed" && (
        <div className="pr-merge-item">
          <p>{P.prClosed}</p>
        </div>
      )}
      {area.state === "open" && detail.merge.requiredReviews && <RequiredReviews reviews={detail.merge.requiredReviews} />}
      {area.state === "open" && detail.checkList.length > 0 && <StatusChecks detail={detail} />}
      {area.state === "open" && <MergeStatus readiness={area.readiness} />}
      {area.action === "ready" && <ReadyForReview />}
      {area.action === "merge" && <MergeActions detail={detail} />}
      {area.canDeleteBranch && <DeleteBranch detail={detail} />}
    </section>
  );
}

// GitHub 는 머지 가능 여부를 늦게 계산한다(UNKNOWN). 확장처럼 3초마다 다시 읽되, 읽기만 하고 열 번에서 멈춘다.
function useMergeabilityPoll(unknown: boolean) {
  const actions = usePrActions();
  const tries = useRef(0);
  useEffect(() => {
    if (!unknown) {
      tries.current = 0;
      return;
    }
    if (tries.current >= 10) return;
    const timer = setTimeout(() => {
      tries.current++;
      void actions.reload(true);
    }, 3000);
    return () => clearTimeout(timer);
  });
}

function RequiredReviews({ reviews }: { reviews: PrRequiredReviews }) {
  return (
    <div className="pr-merge-item">
      <RequiredReviewIcon state={reviews.state} />
      <p>{requiredReviewSummary(reviews)}</p>
    </div>
  );
}

function RequiredReviewIcon({ state }: { state: PrRequiredReviews["state"] }) {
  if (state === "pending")
    return (
      <span className="pr-merge-icon" data-kind="failure">
        <Codicon name="request-changes" size={16} />
      </span>
    );
  return <CheckIcon kind={state === "failure" ? "failure" : "success"} size={16} />;
}

// 확장처럼 실패한 체크가 있으면 펼친 채로 시작한다.
function StatusChecks({ detail }: { detail: PrDetail }) {
  const failing = detail.checkList.some((c) => c.state === "failure");
  const [open, setOpen] = useState(failing);
  useEffect(() => {
    if (failing) setOpen(true);
  }, [failing]);
  return (
    <div className="pr-merge-checks">
      <div className="pr-merge-item">
        <CheckIcon kind={overallCheckKind(detail)} size={16} />
        <p>{checksSummary(detail.checkList)}</p>
        <Button variant="secondary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? P.hideChecks : P.showChecks}
        </Button>
      </div>
      {open && (
        <div className="pr-merge-check-list">
          {sortChecks(detail.checkList).map((check) => (
            <MergeCheckRow key={check.name} check={check} />
          ))}
        </div>
      )}
    </div>
  );
}

// 확장처럼 목록에서 계산한다(실패가 하나라도 있으면 실패, 다음 진행 중). 목록이 없을 때만 GitHub 의 rollup 을 쓴다.
function overallCheckKind(detail: PrDetail): CheckKind {
  if (detail.checkList.some((c) => c.state === "failure")) return "failure";
  if (detail.checkList.some((c) => c.state === "pending")) return "pending";
  return detail.checkList.length ? "success" : (checkKindOf(detail.checks) ?? "neutral");
}

function MergeCheckRow({ check }: { check: PrCheck }) {
  return (
    <div className="pr-check-row">
      <CheckIcon kind={check.state} />
      {check.url ? (
        <a href={check.url} target="_blank" rel="noreferrer" className="pr-check-name" title={check.name}>
          {check.name}
        </a>
      ) : (
        <span className="pr-check-name" title={check.name}>
          {check.name}
        </span>
      )}
      <span className="pr-faint">{check.detail}</span>
    </div>
  );
}

// 확장의 MergeStatus 줄: 충돌, 보호 규칙, 뒤처짐은 빨강 엑스, 머지 가능은 초록 체크, 계산 중은 진행 표시.
function MergeStatus({ readiness }: { readiness: MergeReadiness }) {
  const kind: CheckKind = readiness === "mergeable" ? "success" : readiness === "unknown" ? "pending" : "failure";
  return (
    <div className="pr-merge-item" data-readiness={readiness}>
      <CheckIcon kind={kind} size={16} />
      <p>{P.mergeStatus[readiness]}</p>
    </div>
  );
}

function ReadyForReview() {
  const busy = usePrView((v) => v.busy);
  const actions = usePrActions();
  return (
    <div className="pr-merge-item pr-merge-ready">
      <span className="pr-merge-icon" data-kind="draft">
        <Codicon name="git-pull-request-draft" size={16} />
      </span>
      <div className="pr-merge-text">
        <span className="pr-merge-heading">{P.draftHeading}</span>
        <span className="pr-faint">{P.draftMeta}</span>
      </div>
      <Button variant="primary" disabled={busy !== null} onClick={() => void actions.readyForReview()}>
        {P.readyForReview}
      </Button>
    </div>
  );
}

// 확장의 Merge: "Merge Pull Request using method [방식]" 에서 버튼을 누르면 확인 단계(ConfirmMerge)로 바뀐다.
// 방식 목록은 셋 다 보이고 저장소가 허용하지 않는 것은 "(not enabled)" 로 꺼져 있다.
function MergeActions({ detail }: { detail: PrDetail }) {
  const initial = defaultMergeMethod(detail.merge.methods);
  const [method, setMethod] = useState<PrMergeMethod | null>(initial);
  const [confirming, setConfirming] = useState<PrMergeMethod | null>(null);
  const chosen = method && detail.merge.methods[method] ? method : initial;
  if (confirming) return <ConfirmMerge detail={detail} method={confirming} cancel={() => setConfirming(null)} />;
  return (
    <div className="pr-merge-item pr-merge-actions">
      <Button variant="primary" disabled={!chosen} onClick={() => chosen && setConfirming(chosen)}>
        {P.mergePullRequest}
      </Button>
      <span className="pr-faint">{P.usingMethod}</span>
      <Select value={chosen ?? undefined} onValueChange={(value) => setMethod(value as PrMergeMethod)}>
        <SelectTrigger boxed aria-label={P.selectMergeMethod} className="pr-merge-method">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MERGE_METHODS.map((m) => (
            <SelectItem key={m} value={m} disabled={!detail.merge.methods[m]}>
              {P.mergeMethod[m]}
              {!detail.merge.methods[m] && P.notEnabled}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// 확인 단계: merge 와 squash 는 커밋 제목과 본문(저장소 설정의 기본 문구)을 고칠 수 있고, rebase 는 입력칸 없이 버튼만 있다.
function ConfirmMerge({ detail, method, cancel }: { detail: PrDetail; method: PrMergeMethod; cancel: () => void }) {
  const busy = usePrView((v) => v.busy);
  const actions = usePrActions();
  const preset = method === "rebase" ? { title: "", body: "" } : detail.merge.commitText[method];
  const [title, setTitle] = useState(preset.title);
  const [body, setBody] = useState(preset.body);
  // 확인 단계를 연 때의 head. 그 뒤 자동 새로 읽기로 새 커밋이 들어와도 본 적 없는 커밋까지 머지하지 않게, 이 head 가 아니면 GitHub 가 거절한다.
  const [seenHead] = useState(detail.headSha);
  return (
    <form
      className="pr-merge-item pr-merge-confirm"
      onSubmit={(e) => {
        e.preventDefault();
        void actions.merge(method, title, body, seenHead);
      }}
    >
      {method !== "rebase" && <input className="pr-merge-title" aria-label={P.commitTitle} value={title} onChange={(e) => setTitle(e.target.value)} />}
      {method !== "rebase" && <textarea className="pr-composer-input" aria-label={P.commitBody} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />}
      <div className="pr-composer-actions">
        <span className="spacer" />
        <Button variant="secondary" onClick={cancel}>
          {P.cancel}
        </Button>
        <Button variant="primary" type="submit" disabled={busy !== null}>
          {P.confirmMerge(method, P.mergeMethod[method])}
        </Button>
      </div>
    </form>
  );
}

// 확장의 Delete Branch... 는 지울 것을 고르는 확인 창을 띄운다. 여기서는 원격 head 브랜치 하나만 고를 수 있다(로컬 브랜치와 worktree 는 다루지 않는다).
function DeleteBranch({ detail }: { detail: PrDetail }) {
  const busy = usePrView((v) => v.busy);
  const actions = usePrActions();
  const remote = usePr((s) => s.status?.repos.find((r) => r.fullName === detail.merge.headRepoName)?.remote ?? null);
  const [asking, setAsking] = useState(false);
  const remoteBranch = remote ? `${remote}/${detail.headRef}` : detail.headRef;
  if (!asking)
    return (
      <div className="pr-merge-item">
        <Button variant="secondary" disabled={busy !== null} onClick={() => setAsking(true)}>
          {P.deleteBranch}
        </Button>
      </div>
    );
  return (
    <div className="pr-merge-item pr-merge-delete" role="dialog" aria-label={P.deleteBranchPrompt(detail.number)}>
      <span className="pr-merge-heading">{P.deleteBranchPrompt(detail.number)}</span>
      <span className="pr-faint">{P.deleteBranchDetail}</span>
      <span className="pr-faint">{P.remoteBranch(remoteBranch)}</span>
      {detail.merge.headRepoName && <span className="pr-faint">{P.remoteRepository(`https://github.com/${detail.merge.headRepoName}`)}</span>}
      <div className="pr-composer-actions">
        <span className="spacer" />
        <Button variant="secondary" onClick={() => setAsking(false)}>
          {P.cancel}
        </Button>
        <Button variant="primary" className="pr-danger" disabled={busy !== null} onClick={() => void actions.deleteBranch().then((done) => done && setAsking(false))}>
          {P.deleteRemoteBranch}
        </Button>
      </div>
    </div>
  );
}
