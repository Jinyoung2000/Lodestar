// LINEAR: Linear 연동의 데몬 RPC 타입과 순수 함수. 데몬(server/linear*.ts), 웹(Settings, 보드), 시험이 같은 모양을 쓴다.
// Linear 는 이슈 목록을 보드의 두 번째 출처로 띄우기 위해서만 읽고, 상태와 우선순위 두 가지만 바꾼다. 로컬 카드로 복제하지 않는다.

export const LINEAR_STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const;
export type LinearStateType = (typeof LINEAR_STATE_TYPES)[number];

// 0 은 우선순위 없음, 1 긴급 ... 4 낮음 (Linear 의 priority 값 그대로)
export const LINEAR_PRIORITIES = [0, 1, 2, 3, 4] as const;
export type LinearPriority = (typeof LINEAR_PRIORITIES)[number];

// 실패 분류. 화면은 kind 로 안내 문구를 고른다.
// noKey: 키체인에 키가 없음, invalidKey: 키가 거절됨(401), forbidden: 권한 없음, network: 닿지 못함, rateLimited: 요청 수 제한(retryAfterSec 뒤 다시),
// badRequest: 요청 값이 틀림, keychain: 키체인을 읽거나 쓰지 못함, server: Linear 쪽 오류
export type LinearErrorKind = "noKey" | "invalidKey" | "forbidden" | "network" | "rateLimited" | "badRequest" | "keychain" | "server";
export type LinearError = { kind: LinearErrorKind; message: string; retryAfterSec?: number };
export type LinearResult<T> = { ok: true; data: T } | { ok: false; error: LinearError };

export type LinearViewer = { id: string; name: string; email: string; avatarUrl: string | null };

// connected 가 false 일 때 error.kind 가 noKey 면 "연결 안 됨", 그 밖이면 키는 있는데 쓸 수 없는 상태(invalidKey 등)다.
export type LinearStatus = { connected: true; viewer: LinearViewer; organization: { name: string; urlKey: string } | null } | { connected: false; error: LinearError };

export type LinearState = { id: string; name: string; type: LinearStateType; color: string; position: number };
export type LinearTeam = { id: string; key: string; name: string; cyclesEnabled: boolean; states: LinearState[] };
export type LinearLabel = { id: string; name: string; color: string; teamId: string | null };
export type LinearCycle = { id: string; teamId: string; number: number; name: string | null; startsAt: string; endsAt: string; isActive: boolean; isNext: boolean };
export type LinearMeta = { teams: LinearTeam[]; labels: LinearLabel[]; cycles: LinearCycle[]; fetchedAt: string };

// 보드 카드에 바로 쓰는 이슈 모양. description 은 앞부분만(descriptionTruncated 가 true 면 잘렸다). 전체는 linear.issue 로 읽는다.
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

// 필터의 모든 칸은 선택이다. 빈 필터는 "열린 이슈 전체"(includeCompleted 가 아니면 completed, canceled 제외)다.
// assignee: 없으면 담당자 상관없음, "me" 는 나, "unassigned"(또는 null)는 담당자 없음, 그 밖의 문자열은 사용자 id.
// labelIds 는 하나라도 붙은 이슈, stateTypes 와 priorities 도 목록 중 하나면 통과. 서로 다른 칸은 모두 만족해야 한다.
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

// "내 이슈": 담당자가 나이고 열린 상태. 보드의 빠른 필터가 이 값을 그대로 보낸다.
export const MY_ISSUES_FILTER: LinearIssueFilter = { assignee: "me" };

export type LinearIssuePage = { issues: LinearIssue[]; hasNextPage: boolean; endCursor: string | null; fetchedAt: string };

// 세션과 이슈를 잇는 표지. Agent.linearIssue 에 저장하고 사이드바와 보드가 식별자와 링크를 보인다.
export type LinearIssueRef = { identifier: string; title: string; url: string };

// 쓰기 요청은 화면이 사용자의 클릭으로 보낼 때만 confirmed: true 를 싣는다(server/pr.ts 와 같은 규칙).
export type LinearRpcMethods = {
  "linear.status": { params: { force?: boolean }; result: LinearStatus };
  "linear.setKey": { params: { key: string; confirmed: true }; result: LinearStatus };
  "linear.clearKey": { params: { confirmed: true }; result: LinearStatus };
  "linear.meta": { params: { force?: boolean }; result: LinearResult<LinearMeta> };
  "linear.issues": { params: { filter?: LinearIssueFilter; first?: number; after?: string | null; force?: boolean }; result: LinearResult<LinearIssuePage> };
  // 한 이슈의 전체 설명까지. 세션 초안(linearIssueDraft)이 쓴다.
  "linear.issue": { params: { id: string; force?: boolean }; result: LinearResult<LinearIssue> };
  "linear.updateIssue": { params: { id: string; stateId?: string; priority?: LinearPriority; confirmed: true }; result: LinearResult<LinearIssue> };
  // 로컬 표지만 바꾼다. Linear 에는 쓰지 않는다.
  "agents.setLinearIssue": { params: { agentId: string; issue: LinearIssueRef | null }; result: null };
};

export function issueRefOf(issue: Pick<LinearIssue, "identifier" | "title" | "url">): LinearIssueRef {
  return { identifier: issue.identifier, title: issue.title, url: issue.url };
}

// 이슈에서 세션을 시작할 때 입력창에 채울 초안. 식별자, 제목, URL, 상태와 우선순위와 라벨, 설명 순서다.
// 설명이 잘려 있으면 알리고, 전체가 필요하면 linear.issue 로 읽은 이슈를 넘긴다.
export function linearIssueDraft(issue: LinearIssue): { sessionTitle: string; prompt: string } {
  const facts = [`Status: ${issue.state.name}`, `Priority: ${issue.priorityLabel}`, ...(issue.labels.length ? [`Labels: ${issue.labels.map((l) => l.name).join(", ")}`] : [])].join(", ");
  const description = issue.description?.trim() ?? "";
  const body = description ? (issue.descriptionTruncated ? `${description}\n(The description is cut off. Open the issue for the rest.)` : description) : "";
  const prompt = [`${issue.identifier}: ${issue.title}`, issue.url, facts, ...(body ? ["", body] : [])].join("\n");
  return { sessionTitle: `${issue.identifier} ${issue.title}`.slice(0, 200), prompt };
}
