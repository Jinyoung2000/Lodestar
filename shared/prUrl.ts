import type { PrDetail } from "./prTypes";

export type PrTab = "overview" | "commits" | "files";

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

export const anchorKey = (anchor: PrAnchor) => (anchor.kind === "checks" ? "checks" : `${anchor.kind}-${anchor.id}`);

export type FocusTarget = { tab: PrTab; file: string | null };

export function resolveFocus(detail: PrDetail, anchor: PrAnchor): FocusTarget | null {
  if (anchor.kind === "checks") return { tab: "overview", file: null };
  if (anchor.kind === "review") return detail.timeline.some((entry) => entry.kind === "review" && entry.anchorId === anchor.id) ? { tab: "overview", file: null } : null;
  if (detail.timeline.some((entry) => entry.kind === "comment" && entry.comment.anchorId === anchor.id)) return { tab: "overview", file: null };
  const thread = detail.threads.find((t) => t.comments.some((c) => c.anchorId === anchor.id));
  return thread ? { tab: "files", file: thread.path } : null;
}
