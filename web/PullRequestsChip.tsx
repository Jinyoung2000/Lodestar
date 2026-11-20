import { ChevronDown } from "./icons";
import { openPrBesideByUrl } from "./prStore";
import { useStore } from "./store";
import { S } from "./strings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

// 입력창 위 변경 칩 옆의 "N Pull Requests" 칩. 누르면 이 브랜치의 PR 목록이 열리고, 항목을 고르면 그 PR 을 옆 칸 탭의 PR 화면(web/PullRequestView.tsx)으로 연다. 대화는 그대로 보인다.
export function PullRequestsChip({ agentId }: { agentId: string }) {
  const prs = useStore((s) => s.prs[agentId]);
  if (!prs?.available || prs.prs.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="chip" aria-label={S.pullRequestsMenuAria}>
          <span className="chip-main">{S.pullRequests(prs.prs.length)}</span>
          <ChevronDown size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="pr-menu">
        {prs.prs.map((pr) => (
          <DropdownMenuItem key={pr.number} onSelect={() => openPrBesideByUrl(pr.url, agentId)}>
            <span className="pr-menu-number">#{pr.number}</span>
            <span className="pr-menu-title">{pr.title}</span>
            <span className="pr-menu-state">{S.pullRequestState(pr.state)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
