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

function ConfirmMerge({ detail, method, cancel }: { detail: PrDetail; method: PrMergeMethod; cancel: () => void }) {
  const busy = usePrView((v) => v.busy);
  const actions = usePrActions();
  const preset = method === "rebase" ? { title: "", body: "" } : detail.merge.commitText[method];
  const [title, setTitle] = useState(preset.title);
  const [body, setBody] = useState(preset.body);
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
