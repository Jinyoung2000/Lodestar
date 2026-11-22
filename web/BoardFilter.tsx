import type { Board, BoardPriority } from "../shared/protocol";
import { LabelChip, PriorityIcon, stopEscape } from "./BoardParts";
import { Close, Filter } from "./icons";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "./ui/dropdown-menu";

export type Filters = { priorities: number[]; labels: string[] };

export const hasFilters = (filters: Filters) => filters.priorities.length > 0 || filters.labels.length > 0;

const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

export function boardLabels(board: Board): string[] {
  const seen = new Map<string, string>();
  for (const card of board.cards) for (const label of card.labels) if (!seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export function BoardFilter({ board, filters, onChange }: { board: Board; filters: Filters; onChange: (next: Filters) => void }) {
  const count = filters.priorities.length + filters.labels.length;
  const labels = boardLabels(board);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={S.boardFilter} title={S.boardFilter} data-active={count > 0 ? "" : undefined}>
          <Filter size={14} /> {count > 0 ? S.filterCount(count) : S.filter}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onEscapeKeyDown={stopEscape}>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{S.filterPriority}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent onEscapeKeyDown={stopEscape}>
            {S.priorityNames.map((name, i) => (
              <DropdownMenuCheckboxItem key={name} checked={filters.priorities.includes(i)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => onChange({ ...filters, priorities: toggle(filters.priorities, i) })}>
                <PriorityIcon priority={i as BoardPriority} />
                {name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{S.filterLabel}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent onEscapeKeyDown={stopEscape}>
            {labels.length === 0 && (
              <DropdownMenuItem disabled>{S.filterNoLabels}</DropdownMenuItem>
            )}
            {labels.map((label) => (
              <DropdownMenuCheckboxItem key={label} checked={filters.labels.includes(label.toLowerCase())} onSelect={(e) => e.preventDefault()} onCheckedChange={() => onChange({ ...filters, labels: toggle(filters.labels, label.toLowerCase()) })}>
                <LabelChip label={label} />
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={count === 0} onSelect={() => onChange({ priorities: [], labels: [] })}>
          {S.filterClear}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FilterChips({ filters, onChange }: { filters: Filters; onChange: (next: Filters) => void }) {
  const priorityText = filters.priorities.map((p) => S.priorityNames[p]).join(", ");
  const labelText = filters.labels.join(", ");
  return (
    <div className="board-filters" role="group" aria-label={S.boardFilter}>
      {filters.priorities.length > 0 && (
        <span className="filter-chip" data-facet="priority">
          {S.filterChipPriority(priorityText)}
          <button type="button" className="label-remove" aria-label={S.filterRemove(priorityText)} onClick={() => onChange({ ...filters, priorities: [] })}>
            <Close size={12} />
          </button>
        </span>
      )}
      {filters.labels.length > 0 && (
        <span className="filter-chip" data-facet="label">
          {S.filterChipLabel(labelText)}
          <button type="button" className="label-remove" aria-label={S.filterRemove(labelText)} onClick={() => onChange({ ...filters, labels: [] })}>
            <Close size={12} />
          </button>
        </span>
      )}
      <Button variant="ghost" size="sm" onClick={() => onChange({ priorities: [], labels: [] })}>
        {S.filterClear}
      </Button>
    </div>
  );
}
