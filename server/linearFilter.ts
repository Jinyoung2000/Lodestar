import { LINEAR_PRIORITIES, LINEAR_STATE_TYPES, type LinearIssueFilter, type LinearPriority, type LinearStateType } from "../shared/linear";

// 같은 객체 안의 칸은 AND, `or` 는 그 안의 후보 중 하나. 칸마다 서로 다른 조건이라 모두 한 객체에 두고, 검색어만 or 로 묶는다.

export class BadFilter extends Error {}

const MAX_IDS = 50;
const MAX_ID_LENGTH = 100;
const MAX_QUERY = 200;
const IDENTIFIER = /^([A-Za-z][A-Za-z0-9]{0,15})-(\d{1,9})$/;

export function normalizeFilter(raw: unknown): LinearIssueFilter {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new BadFilter("filter must be an object");
  const f = raw as Record<string, unknown>;
  const out: LinearIssueFilter = {};

  const ids = (name: string): string[] | undefined => {
    const value = f[name];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_IDS || value.some((v) => typeof v !== "string" || !v || v.length > MAX_ID_LENGTH)) throw new BadFilter(`${name} must be a list of up to ${MAX_IDS} ids`);
    return value.length ? [...new Set(value as string[])].sort() : undefined;
  };

  const teamIds = ids("teamIds");
  if (teamIds) out.teamIds = teamIds;
  if (f.assignee !== undefined) {
    if (f.assignee === null) out.assignee = "unassigned";
    else if (typeof f.assignee === "string" && f.assignee.length > 0 && f.assignee.length <= MAX_ID_LENGTH) out.assignee = f.assignee;
    else throw new BadFilter("assignee must be me, unassigned, null or a user id");
  }
  if (f.stateTypes !== undefined) {
    if (!Array.isArray(f.stateTypes) || f.stateTypes.some((t) => !(LINEAR_STATE_TYPES as readonly unknown[]).includes(t))) throw new BadFilter("stateTypes has an unknown state type");
    if (f.stateTypes.length) out.stateTypes = [...new Set(f.stateTypes as LinearStateType[])].sort();
  }
  if (f.cycleId !== undefined) {
    if (typeof f.cycleId !== "string" || !f.cycleId || f.cycleId.length > MAX_ID_LENGTH) throw new BadFilter("cycleId must be an id");
    out.cycleId = f.cycleId;
  }
  const labelIds = ids("labelIds");
  if (labelIds) out.labelIds = labelIds;
  if (f.priorities !== undefined) {
    if (!Array.isArray(f.priorities) || f.priorities.some((p) => !(LINEAR_PRIORITIES as readonly unknown[]).includes(p))) throw new BadFilter("priorities must be whole numbers from 0 to 4");
    if (f.priorities.length) out.priorities = [...new Set(f.priorities as LinearPriority[])].sort();
  }
  if (f.query !== undefined) {
    if (typeof f.query !== "string" || f.query.length > MAX_QUERY * 4) throw new BadFilter("query must be text");
    const query = f.query.trim().slice(0, MAX_QUERY);
    if (query) out.query = query;
  }
  if (f.includeCompleted !== undefined) {
    if (typeof f.includeCompleted !== "boolean") throw new BadFilter("includeCompleted must be true or false");
    if (f.includeCompleted) out.includeCompleted = true;
  }
  return out;
}

export function buildIssueFilter(filter: LinearIssueFilter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (filter.teamIds?.length) out.team = { id: { in: filter.teamIds } };
  if (filter.assignee === "me") out.assignee = { isMe: { eq: true } };
  else if (filter.assignee === "unassigned" || filter.assignee === null) out.assignee = { null: true };
  else if (filter.assignee) out.assignee = { id: { eq: filter.assignee } };
  if (filter.stateTypes?.length) out.state = { type: { in: filter.stateTypes } };
  else if (!filter.includeCompleted) out.state = { type: { nin: ["completed", "canceled"] } };
  if (filter.cycleId) out.cycle = { id: { eq: filter.cycleId } };
  if (filter.labelIds?.length) out.labels = { id: { in: filter.labelIds } };
  if (filter.priorities?.length) out.priority = { in: filter.priorities };
  if (filter.query) {
    const candidates: Record<string, unknown>[] = [{ title: { containsIgnoreCase: filter.query } }, { description: { containsIgnoreCase: filter.query } }];
    const match = IDENTIFIER.exec(filter.query);
    if (match) candidates.push({ team: { key: { eqIgnoreCase: match[1] } }, number: { eq: Number(match[2]) } });
    out.or = candidates;
  }
  return out;
}
