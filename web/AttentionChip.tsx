import { forwardRef, useMemo } from "react";
import { attentionItems, awayItems } from "../shared/attention";
import { clampTitle } from "../shared/sessionTitle";
import { handleNotificationAction } from "./notifications";
import { useStore } from "./store";
import { S } from "./strings";
import { Button, type ButtonProps } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

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
