import type { PermissionMode } from "./protocol";


export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexReviewer = "user" | "auto_review";

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

export const codexPermission = (mode: PermissionMode): CodexPermission | null => TABLE[mode];

export const codexSupportsMode = (mode: PermissionMode) => TABLE[mode] !== null;

export function withWritableRoots(policy: CodexSandboxPolicy, roots: readonly string[]): CodexSandboxPolicy {
  if (policy.type !== "workspaceWrite" || !roots.length) return policy;
  return { ...policy, writableRoots: [...new Set([...policy.writableRoots, ...roots])] };
}

export function codexSessionConfig(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [`shell_environment_policy.set.${key}`, value]));
}

export const CODEX_FALLBACK_MODE: PermissionMode = "default";

export const CODEX_MODE_NOTES: Record<PermissionMode, string> = {
  default: "approval untrusted, sandbox workspace-write. Asks before any file change and before commands outside Codex's trusted list.",
  acceptEdits: "approval on-request, sandbox workspace-write. Edits inside the folder and sandboxed commands run; only requests to leave the sandbox ask.",
  plan: "Codex app-server has no plan mode setting yet, so this mode is not available for Codex sessions.",
  auto: "approval on-request, sandbox workspace-write, reviewer auto_review. A reviewer subagent decides requests to leave the sandbox.",
  bypassPermissions: "approval never, sandbox danger-full-access. Runs everything without asking and without a sandbox.",
};
