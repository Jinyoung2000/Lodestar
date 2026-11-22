import { LINEAR_PRIORITIES, LINEAR_STATE_TYPES, type LinearCycle, type LinearIssue, type LinearLabel, type LinearMeta, type LinearPriority, type LinearState, type LinearStateType, type LinearTeam, type LinearViewer } from "../shared/linear";


export const DESCRIPTION_CHARS = 600;
export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

const ISSUE_FIELDS = `
  id identifier title description url priority priorityLabel updatedAt
  state { id name type color }
  labels(first: 10) { nodes { name color } }
  assignee { id name avatarUrl }
  team { id key name }
  cycle { number name }
`;

export const VIEWER_QUERY = `query LodestarViewer { viewer { id name email avatarUrl } organization { name urlKey } }`;

export const ISSUES_QUERY = `query LodestarIssues($filter: IssueFilter, $first: Int, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const ISSUE_QUERY = `query LodestarIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;

export const UPDATE_ISSUE_MUTATION = `mutation LodestarIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

export const META_QUERIES = {
  teams: `query LodestarTeams($after: String) { teams(first: 100, after: $after) { nodes { id key name cyclesEnabled } pageInfo { hasNextPage endCursor } } }`,
  states: `query LodestarStates($after: String) { workflowStates(first: 250, after: $after) { nodes { id name type color position team { id } } pageInfo { hasNextPage endCursor } } }`,
  labels: `query LodestarLabels($after: String) { issueLabels(first: 250, after: $after) { nodes { id name color team { id } } pageInfo { hasNextPage endCursor } } }`,
  cycles: `query LodestarCycles($after: String) { cycles(first: 100, after: $after, filter: { or: [{ isActive: { eq: true } }, { isNext: { eq: true } }] }) { nodes { id number name startsAt endsAt isActive isNext team { id } } pageInfo { hasNextPage endCursor } } }`,
} as const;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

const stateType = (v: unknown): LinearStateType => ((LINEAR_STATE_TYPES as readonly unknown[]).includes(v) ? (v as LinearStateType) : "unstarted");
const priorityOf = (v: unknown): LinearPriority => ((LINEAR_PRIORITIES as readonly unknown[]).includes(v) ? (v as LinearPriority) : 0);

export function parseIssue(raw: unknown, full = false): LinearIssue | null {
  const r = obj(raw);
  if (!r || typeof r.id !== "string" || typeof r.identifier !== "string") return null;
  const state = obj(r.state);
  const team = obj(r.team);
  const assignee = obj(r.assignee);
  const cycle = obj(r.cycle);
  const description = typeof r.description === "string" && r.description ? r.description : null;
  const truncated = !full && description !== null && description.length > DESCRIPTION_CHARS;
  return {
    id: r.id,
    identifier: r.identifier,
    title: str(r.title),
    description: truncated ? description.slice(0, DESCRIPTION_CHARS) : description,
    descriptionTruncated: truncated,
    url: str(r.url),
    priority: priorityOf(r.priority),
    priorityLabel: str(r.priorityLabel),
    state: { id: str(state?.id), name: str(state?.name), type: stateType(state?.type), color: str(state?.color) },
    labels: (Array.isArray(obj(r.labels)?.nodes) ? (obj(r.labels)?.nodes as unknown[]) : []).flatMap((l) => {
      const label = obj(l);
      return label ? [{ name: str(label.name), color: str(label.color) }] : [];
    }),
    assignee: assignee ? { id: str(assignee.id), name: str(assignee.name), avatarUrl: typeof assignee.avatarUrl === "string" ? assignee.avatarUrl : null } : null,
    team: { id: str(team?.id), key: str(team?.key), name: str(team?.name) },
    cycle: cycle ? { number: num(cycle.number), name: typeof cycle.name === "string" ? cycle.name : null } : null,
    updatedAt: str(r.updatedAt),
  };
}

export function parseViewer(raw: unknown): LinearViewer | null {
  const r = obj(raw);
  return r && typeof r.id === "string" ? { id: r.id, name: str(r.name), email: str(r.email), avatarUrl: typeof r.avatarUrl === "string" ? r.avatarUrl : null } : null;
}

export type MetaRaw = { teams: unknown[]; states: unknown[]; labels: unknown[]; cycles: unknown[] };

export function parseMeta(raw: MetaRaw, fetchedAt: string): LinearMeta {
  const states = new Map<string, LinearState[]>();
  for (const item of raw.states) {
    const r = obj(item);
    const teamId = str(obj(r?.team)?.id);
    if (!r || !teamId || typeof r.id !== "string") continue;
    const list = states.get(teamId) ?? [];
    list.push({ id: r.id, name: str(r.name), type: stateType(r.type), color: str(r.color), position: num(r.position) });
    states.set(teamId, list);
  }
  const teams: LinearTeam[] = raw.teams.flatMap((item) => {
    const r = obj(item);
    if (!r || typeof r.id !== "string") return [];
    return [{ id: r.id, key: str(r.key), name: str(r.name), cyclesEnabled: r.cyclesEnabled === true, states: (states.get(r.id) ?? []).sort((a, b) => a.position - b.position) }];
  });
  const labels: LinearLabel[] = raw.labels.flatMap((item) => {
    const r = obj(item);
    return r && typeof r.id === "string" ? [{ id: r.id, name: str(r.name), color: str(r.color), teamId: obj(r.team) ? str(obj(r.team)?.id) || null : null }] : [];
  });
  const cycles: LinearCycle[] = raw.cycles.flatMap((item) => {
    const r = obj(item);
    const teamId = str(obj(r?.team)?.id);
    return r && typeof r.id === "string" && teamId ? [{ id: r.id, teamId, number: num(r.number), name: typeof r.name === "string" ? r.name : null, startsAt: str(r.startsAt), endsAt: str(r.endsAt), isActive: r.isActive === true, isNext: r.isNext === true }] : [];
  });
  return { teams, labels, cycles, fetchedAt };
}
