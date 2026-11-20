import { PrAvatar, useNow } from "./PrBits";
import { usePrView } from "./prStore";
import { P } from "./prStrings";
import { relativeTime } from "./sessionList";

// Commits: 이 PR 의 커밋을 오래된 것부터. 줄을 누르면 GitHub 의 커밋 페이지를 밖에서 연다.
export function PrCommits() {
  const commits = usePrView((v) => v.detail?.commitList);
  const total = usePrView((v) => v.detail?.commitCount ?? 0);
  const now = useNow();
  if (!commits) return null;
  if (commits.length === 0) return <div className="pr-empty">{P.noCommits}</div>;
  return (
    <div className="pr-commits" role="list">
      {total > commits.length && <div className="pr-note-box">{P.commitsTruncated(commits.length, total)}</div>}
      {commits.map((commit) => (
        <button key={commit.oid} type="button" role="listitem" className="pr-commit-row list-row" title={P.openCommitTip(commit.abbreviatedOid)} disabled={!commit.url} onClick={() => window.open(commit.url, "_blank", "noreferrer")}>
          <PrAvatar user={commit.author ?? (commit.authorName ? { login: commit.authorName, avatarUrl: null } : null)} size={16} />
          <span className="pr-commit-headline" title={commit.headline}>
            {commit.headline}
          </span>
          <span className="pr-faint pr-commit-author">{commit.author?.login ?? commit.authorName ?? ""}</span>
          <span className="pr-faint" title={commit.authoredAt}>
            {relativeTime(commit.authoredAt, now)}
          </span>
          <code className="pr-commit-oid">{commit.abbreviatedOid}</code>
        </button>
      ))}
    </div>
  );
}
