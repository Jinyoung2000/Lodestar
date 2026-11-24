import type { AssistantState } from "@shared/assistant";
import { clockText, dayText } from "./mateCore.generated";
import type { FollowUpItem } from "@shared/followups";
import type { SnoozeChoice } from "./mateCore.generated";
import type { Agent } from "@shared/protocol";

export function ageText(iso: string | null, now: number): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(1, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export const whenText = (iso: string) => `${dayText(new Date(iso))}, ${clockText(new Date(iso))}`;

const KIND_FALLBACK: Record<FollowUpItem["kind"], string> = {
  approval: "A tool call is waiting for approval",
  question: "The session asked a question",
  plan: "A plan is ready for your review",
  ask: "The session asked for a decision",
};

export const KIND_LABEL: Record<FollowUpItem["kind"], string> = { approval: "Approval", question: "Question", plan: "Plan", ask: "Asked in reply" };

export const itemText = (item: Pick<FollowUpItem, "kind" | "text">) => item.text || KIND_FALLBACK[item.kind];

export const SNOOZE_LABEL: Record<SnoozeChoice, string> = { "2h": "In 2 hours", tomorrow: "Tomorrow morning", nextWeek: "Next week" };

export function mateStatus(agent: Pick<Agent, "status">, assistant: Pick<AssistantState, "busy" | "lastCheckIn">, now: number): string {
  if (assistant.busy) return "Checking in…";
  if (agent.status === "running") return "Working…";
  if (agent.status === "waiting") return "Waiting for approval";
  const last = assistant.lastCheckIn;
  if (!last) return "Ready";
  return last.spoke ? `Checked in ${ageText(last.at, now)} ago` : `Checked in ${ageText(last.at, now)} ago, nothing to report`;
}
