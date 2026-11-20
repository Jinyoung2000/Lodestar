import type { PrDetail } from "./prTypes";

// GitHub PR 주소를 Lodestar PR 화면의 어느 탭, 어느 코멘트로 열지 읽는다. DOM 과 저장소를 모르는 순수 함수만 둔다(시험 대상).

export type PrTab = "overview" | "commits" | "files";

// comment 는 #discussion_r<번호>, #r<번호>, #issuecomment-<번호>, review 는 #pullrequestreview-<번호>, checks 는 /checks 주소다.
export type PrAnchor = { kind: "comment"; id: string } | { kind: "review"; id: string } | { kind: "checks" };

export type PrLink = { repo: string; number: number; tab: PrTab; anchor: PrAnchor | null };

const PR_URL = /^https:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(\/[^?#]*)?(?:\?[^#]*)?(?:#(.*))?$/i;

export function parsePrUrl(url: string): PrLink | null {
  const match = PR_URL.exec(url);
  if (!match) return null;
  const [, repo, number, path = "", hash = ""] = match;
  const segment = path.split("/")[1]?.toLowerCase() ?? "";
  const tab: PrTab = segment === "files" || segment === "changes" ? "files" : segment === "commits" ? "commits" : "overview";
  const anchor = segment === "checks" ? { kind: "checks" as const } : anchorOfHash(hash);
  return { repo, number: Number(number), tab, anchor };
}

function anchorOfHash(hash: string): PrAnchor | null {
  const comment = /^(?:discussion_r|issuecomment-|r)(\d+)$/.exec(hash);
  if (comment) return { kind: "comment", id: comment[1] };
  const review = /^pullrequestreview-(\d+)$/.exec(hash);
  return review ? { kind: "review", id: review[1] } : null;
}

export function prRefOfUrl(url: string): { repo: string; number: number } | null {
  const link = parsePrUrl(url);
  return link ? { repo: link.repo, number: link.number } : null;
}

// 화면 요소에 다는 값. 코멘트와 리뷰 카드의 data-pr-anchor 와 같아야 한다.
export const anchorKey = (anchor: PrAnchor) => (anchor.kind === "checks" ? "checks" : `${anchor.kind}-${anchor.id}`);

export type FocusTarget = { tab: PrTab; file: string | null };

// 주소가 가리킨 코멘트가 어느 탭에 있는지. 리뷰 스레드의 코멘트는 Overview 타임라인에 없고 Files 의 diff 줄 아래에 붙으므로, 주소의 탭과 상관없이 그 파일을 고른다.
// 대상이 상세에 없으면 null(지워졌거나 100개 한도 밖).
export function resolveFocus(detail: PrDetail, anchor: PrAnchor): FocusTarget | null {
  if (anchor.kind === "checks") return { tab: "overview", file: null };
  if (anchor.kind === "review") return detail.timeline.some((entry) => entry.kind === "review" && entry.anchorId === anchor.id) ? { tab: "overview", file: null } : null;
  if (detail.timeline.some((entry) => entry.kind === "comment" && entry.comment.anchorId === anchor.id)) return { tab: "overview", file: null };
  const thread = detail.threads.find((t) => t.comments.some((c) => c.anchorId === anchor.id));
  return thread ? { tab: "files", file: thread.path } : null;
}
