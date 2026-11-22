
export const LINEAR_STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const;
export type LinearStateType = (typeof LINEAR_STATE_TYPES)[number];

export const LINEAR_PRIORITIES = [0, 1, 2, 3, 4] as const;
export type LinearPriority = (typeof LINEAR_PRIORITIES)[number];

export type LinearErrorKind = "noKey" | "invalidKey" | "forbidden" | "network" | "rateLimited" | "badRequest" | "keychain" | "server";
export type LinearError = { kind: LinearErrorKind; message: string; retryAfterSec?: number };
export type LinearResult<T> = { ok: true; data: T } | { ok: false; error: LinearError };

export type LinearViewer = { id: string; name: string; email: string; avatarUrl: string | null };

export type LinearStatus = { connected: true; viewer: LinearViewer; organization: { name: string; urlKey: string } | null } | { connected: false; error: LinearError };

export type LinearState = { id: string; name: string; type: LinearStateType; color: string; position: number };
export type LinearTeam = { id: string; key: string; name: string; cyclesEnabled: boolean; states: LinearState[] };
export type LinearLabel = { id: string; name: string; color: string; teamId: string | null };
export type LinearCycle = { id: string; teamId: string; number: number; name: string | null; startsAt: string; endsAt: string; isActive: boolean; isNext: boolean };
export type LinearMeta = { teams: LinearTeam[]; labels: LinearLabel[]; cycles: LinearCycle[]; fetchedAt: string };

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  descriptionTruncated: boolean;
  url: string;
  priority: LinearPriority;
  priorityLabel: string;
  state: { id: string; name: string; type: LinearStateType; color: string };
  labels: { name: string; color: string }[];
  assignee: { id: string; name: string; avatarUrl: string | null } | null;
  team: { id: string; key: string; name: string };
  cycle: { number: number; name: string | null } | null;
  updatedAt: string;
};

export type LinearIssueFilter = {
  teamIds?: string[];
  assignee?: "me" | "unassigned" | (string & {}) | null;
  stateTypes?: LinearStateType[];
  cycleId?: string;
  labelIds?: string[];
  priorities?: LinearPriority[];
  query?: string;
  includeCompleted?: boolean;
};

export type LinearIssuePage = { issues: LinearIssue[]; hasNextPage: boolean; endCursor: string | null; fetchedAt: string };

export type LinearIssueRef = { identifier: string; title: string; url: string };

export type LinearRpcMethods = {
  "linear.status": { params: { force?: boolean }; result: LinearStatus };
  "linear.setKey": { params: { key: string; confirmed: true }; result: LinearStatus };
  "linear.clearKey": { params: { confirmed: true }; result: LinearStatus };
  "linear.meta": { params: { force?: boolean }; result: LinearResult<LinearMeta> };
  "linear.issues": { params: { filter?: LinearIssueFilter; first?: number; after?: string | null; force?: boolean }; result: LinearResult<LinearIssuePage> };
  "linear.issue": { params: { id: string; force?: boolean }; result: LinearResult<LinearIssue> };
  "linear.updateIssue": { params: { id: string; stateId?: string; priority?: LinearPriority; confirmed: true }; result: LinearResult<LinearIssue> };
  "agents.setLinearIssue": { params: { agentId: string; issue: LinearIssueRef | null }; result: null };
};

export function linearIssueDraft(issue: LinearIssue): { sessionTitle: string; prompt: string } {
  const facts = [`Status: ${issue.state.name}`, `Priority: ${issue.priorityLabel}`, ...(issue.labels.length ? [`Labels: ${issue.labels.map((l) => l.name).join(", ")}`] : [])].join(", ");
  const description = issue.description?.trim() ?? "";
  const body = description ? (issue.descriptionTruncated ? `${description}\n(The description is cut off. Open the issue for the rest.)` : description) : "";
  const prompt = [`${issue.identifier}: ${issue.title}`, issue.url, facts, ...(body ? ["", body] : [])].join("\n");
  return { sessionTitle: `${issue.identifier} ${issue.title}`.slice(0, 200), prompt };
}
