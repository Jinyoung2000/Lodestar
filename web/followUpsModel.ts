import { cardKey } from "../shared/board";
import type { Board, Workspace } from "../shared/protocol";

const STEPS = [
  { unit: "min", below: 3600, size: 60 },
  { unit: "hr", below: 86_400, size: 3600 },
  { unit: "day", below: 604_800, size: 86_400 },
  { unit: "wk", below: Infinity, size: 604_800 },
] as const;

const UNIT_WORDS: Record<(typeof STEPS)[number]["unit"], readonly [string, string]> = { min: ["min", "min"], hr: ["h", "h"], day: ["day", "days"], wk: ["week", "weeks"] };

export function ageText(iso: string | null, now: number): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return "";
  const seconds = Math.max(60, Math.round((now - at) / 1000));
  const step = STEPS.find((candidate) => seconds < candidate.below) ?? STEPS[STEPS.length - 1];
  const count = Math.round(seconds / step.size);
  return `${count} ${UNIT_WORDS[step.unit][count === 1 ? 0 : 1]}`;
}

export const agoText = (iso: string | null, now: number) => {
  const age = ageText(iso, now);
  return age ? `${age} ago` : "";
};

export function untilText(iso: string | null, now: number): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(at) - startOfDay(today)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  return `${at.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

export const workspaceNameOf = (workspaces: readonly Workspace[], id: string | null) => workspaces.find((w) => w.id === id)?.name ?? "";

export function cardKeyOf(board: Board | null, agentId: string): string | null {
  const card = board?.cards.find((c) => c.agentIds.includes(agentId));
  return card ? cardKey(card) : null;
}
