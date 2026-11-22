import type { PermissionMode } from "./protocol";

export type AntigravityMode = "default" | "accept-edits" | "auto" | "plan";

const TABLE: Record<PermissionMode, AntigravityMode> = {
  default: "default",
  acceptEdits: "accept-edits",
  plan: "plan",
  auto: "auto",
  bypassPermissions: "auto",
};

export const antigravityMode = (mode: PermissionMode): AntigravityMode => TABLE[mode];

export const antigravityApprovesAll = (mode: PermissionMode) => mode === "bypassPermissions";

export const ANTIGRAVITY_MODE_NOTES: Record<PermissionMode, string> = {
  default: "Antigravity mode default. Asks before edits and commands, per your Antigravity permission settings.",
  acceptEdits: "Antigravity mode accept-edits. File edits in the workspace run without asking; other requests ask.",
  plan: "Antigravity mode plan. Plans carefully before executing a task.",
  auto: "Antigravity mode auto. Edits and safe commands run; irreversible actions ask.",
  bypassPermissions: "Antigravity mode auto, and Lodestar approves every remaining request without asking.",
};
