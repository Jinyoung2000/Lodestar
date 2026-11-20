// CODEX: Codex 앱 서버 프로토콜 중 Lodestar 가 쓰는 부분만 옮긴 타입. 전체는 `codex app-server generate-ts` 로 뽑을 수 있다(0.163.0 기준으로 확인).
// 앱 서버 버전이 바뀌어 모르는 필드나 항목이 와도 깨지지 않도록 읽는 쪽은 전부 선택 필드로 다룬다.

export type CodexJson = null | boolean | number | string | CodexJson[] | { [key: string]: CodexJson };

export type CodexFileChange = {
  path: string;
  kind: { type: "add" | "delete" | "update"; move_path?: string | null };
  diff: string;
};

export type CodexThreadItem = { type: string; id: string } & Record<string, unknown>;

export type CodexTurn = {
  id: string;
  status?: "completed" | "interrupted" | "failed" | "inProgress";
  error?: { message?: string; codexErrorInfo?: unknown; additionalDetails?: string | null } | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  items?: CodexThreadItem[];
};

export type CodexTokenBreakdown = { totalTokens: number; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number };
export type CodexTokenUsage = { total: CodexTokenBreakdown; last: CodexTokenBreakdown; modelContextWindow: number | null };

export type CodexPlanStep = { step: string; status: "pending" | "inProgress" | "completed" };

// 서버가 클라이언트에 보내는 요청 중 승인과 관련된 것
export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
