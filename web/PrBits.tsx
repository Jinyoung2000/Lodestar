import { useEffect, useState } from "react";
import type { PrChecksState, PrReviewDecision, PrSummary, PrUser } from "../shared/prTypes";
import { Codicon, DotSpinner } from "./icons";
import { P } from "./prStrings";

// PR 행, 화면 머리, 체크 목록이 같이 쓰는 작은 조각들.

export function PrAvatar({ user, size = 16 }: { user: PrUser | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initials = (user?.login ?? "?").slice(0, 2).toUpperCase();
  const style = size === 16 ? undefined : { width: size, height: size, fontSize: size / 2 };
  if (user?.avatarUrl && !failed) return <img className="pr-avatar" src={`${user.avatarUrl}${user.avatarUrl.includes("?") ? "&" : "?"}s=${size * 2}`} alt="" loading="lazy" style={style} onError={() => setFailed(true)} />;
  return (
    <span className="pr-avatar" data-fallback="" style={style} aria-hidden="true">
      {initials}
    </span>
  );
}

export function PrStateIcon({ pr }: { pr: Pick<PrSummary, "state" | "isDraft"> }) {
  const kind = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  const name = kind === "merged" ? "git-merge" : kind === "closed" ? "git-pull-request-closed" : kind === "draft" ? "git-pull-request-draft" : "git-pull-request";
  const label = kind === "merged" ? P.merged : kind === "closed" ? P.closed : kind === "draft" ? P.draft : P.open;
  return (
    <span className="pr-state-icon" data-kind={kind} title={label} role="img" aria-label={label}>
      <Codicon name={name} />
    </span>
  );
}

export type CheckKind = "success" | "failure" | "pending" | "neutral";

export function checkKindOf(state: PrChecksState): CheckKind | null {
  if (state === "SUCCESS") return "success";
  if (state === "FAILURE" || state === "ERROR") return "failure";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return null;
}

export function CheckIcon({ kind, size = 12 }: { kind: CheckKind; size?: number }) {
  const label = kind === "success" ? P.checksPassing : kind === "failure" ? P.checksFailing : kind === "pending" ? P.checksPending : "Skipped";
  return (
    <span className="pr-check-icon" data-kind={kind} title={label} role="img" aria-label={label}>
      {kind === "pending" ? <DotSpinner state="waiting" size={size} /> : <Codicon name={kind === "success" ? "check" : kind === "failure" ? "close" : "circle-small-filled"} size={size} />}
    </span>
  );
}

export function reviewLabel(decision: PrReviewDecision): string | null {
  return decision === "APPROVED" ? P.approved : decision === "CHANGES_REQUESTED" ? P.changesRequested : decision === "REVIEW_REQUIRED" ? P.reviewRequired : null;
}

export function ReviewIcon({ decision }: { decision: PrReviewDecision }) {
  const label = reviewLabel(decision);
  if (!label) return null;
  const name = decision === "APPROVED" ? "pass" : decision === "CHANGES_REQUESTED" ? "request-changes" : "eye";
  return (
    <span className="pr-review-icon" data-decision={decision ?? undefined} title={label} role="img" aria-label={label}>
      <Codicon name={name} size={12} />
    </span>
  );
}

// 분 단위로 다시 그려서 상대 시간이 흘러가게 한다.
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
