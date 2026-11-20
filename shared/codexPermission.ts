import type { PermissionMode } from "./protocol";


export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexReviewer = "user" | "auto_review";

// turn/start 의 sandboxPolicy 모양(thread/start 와 thread/resume 은 sandbox 문자열을 받는다)
export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

export type CodexPermission = {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
  sandboxPolicy: CodexSandboxPolicy;
  approvalsReviewer: CodexReviewer;
};

const workspaceWrite: CodexSandboxPolicy = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };

const TABLE: Record<PermissionMode, CodexPermission | null> = {
  default: { approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: workspaceWrite, approvalsReviewer: "user" },
  acceptEdits: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: workspaceWrite, approvalsReviewer: "user" },
  plan: null,
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: workspaceWrite, approvalsReviewer: "auto_review" },
  bypassPermissions: { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" },
};

// null 이면 Codex 에 없는 모드
export const codexPermission = (mode: PermissionMode): CodexPermission | null => TABLE[mode];

export const codexSupportsMode = (mode: PermissionMode) => TABLE[mode] !== null;

// 고를 수 없는 모드일 때 보내려던 값 대신 쓰는 모드. 옛 저장값이 plan 이었을 때 등.
export const CODEX_FALLBACK_MODE: PermissionMode = "default";

// 입력창 권한 메뉴의 설명(Codex 세션에서). 없는 모드는 이유를 돌려준다.
export const CODEX_MODE_NOTES: Record<PermissionMode, string> = {
  default: "approval untrusted, sandbox workspace-write. Asks before any file change and before commands outside Codex's trusted list.",
  acceptEdits: "approval on-request, sandbox workspace-write. Edits inside the folder and sandboxed commands run; only requests to leave the sandbox ask.",
  plan: "Codex app-server has no plan mode setting yet, so this mode is not available for Codex sessions.",
  auto: "approval on-request, sandbox workspace-write, reviewer auto_review. A reviewer subagent decides requests to leave the sandbox.",
  bypassPermissions: "approval never, sandbox danger-full-access. Runs everything without asking and without a sandbox.",
};
