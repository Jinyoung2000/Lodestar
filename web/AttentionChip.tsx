import { forwardRef, useMemo } from "react";
import { attentionItems, awayItems } from "../shared/attention";
import { clampTitle } from "../shared/sessionTitle";
import { handleNotificationAction } from "./notifications";
import { useStore } from "./store";
import { S } from "./strings";
import { Button, type ButtonProps } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

// 제목줄의 작은 칩: 지금 보고 있지 않은 세션 중 사람 차례인 것(승인, 질문, 계획 확인, 개선 세션의 답 대기)이 몇 개인지.
// 하나면 누르는 순간 그 세션으로 가고, 여럿이면 목록에서 고른다. 없으면 아무것도 그리지 않는다. 창이 포커스일 때 OS 알림이 안 나오는 대신 이 칩이 알려 준다.
export function AttentionChip() {
  const agents = useStore((s) => s.agents);
  const feedbacks = useStore((s) => s.feedbacks);
  const panes = useStore((s) => s.panes);
  const centerView = useStore((s) => s.centerView);
  const items = useMemo(() => awayItems(attentionItems(agents, feedbacks), panes, centerView), [agents, feedbacks, panes, centerView]);
  const open = (agentId: string) => handleNotificationAction({ agentId, action: "open" });
  if (items.length === 0) return null;
  if (items.length === 1) return <ChipButton count={1} onClick={() => open(items[0].agentId)} />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ChipButton count={items.length} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={S.attentionMenuAria}>
        {items.map((item) => (
          <DropdownMenuItem key={item.agentId} className="attention-item" onSelect={() => open(item.agentId)}>
            <span className="attention-item-title" title={item.title}>
              {clampTitle(item.title, 60)}
            </span>
            <span className="attention-item-reason">{item.reason === "reply" ? S.attentionReply : S.inputNeeded}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ChipButton = forwardRef<HTMLButtonElement, ButtonProps & { count: number }>(function ChipButton({ count, ...props }, ref) {
  return (
    <Button ref={ref} variant="secondary" size="sm" className="attention-chip" aria-label={S.attentionChipTip(count)} title={S.attentionChipTip(count)} data-attention-count={count} {...props}>
      <span className="attention-dot" aria-hidden="true" />
      <span className="attention-count">{count}</span>
      <span className="attention-word">{S.attentionChipWord(count)}</span>
    </Button>
  );
});
