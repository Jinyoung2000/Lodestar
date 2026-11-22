import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findExecutable, withLoginPath } from "./loginPath";
import { T } from "./strings";
import { version as APP_VERSION } from "../package.json";

export function claudeBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_NAV_CLAUDE) return env.AGENT_NAV_CLAUDE;
  const native = join(env.HOME ?? homedir(), ".local", "bin", "claude");
  if (findExecutable(native, undefined)) return native;
  return findExecutable("claude", withLoginPath(env.PATH)) ?? native;
}

export function claudeInstalled(env: NodeJS.ProcessEnv = process.env) {
  return findExecutable(claudeBin(env), withLoginPath(env.PATH)) !== null;
}

export function claudeErrorText(text: string) {
  return /Claude Code (native binary|executable) not found|spawn \S*claude ENOENT/i.test(text) ? T.claudeNotInstalled : text;
}

const DROPPED_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_USER_EMAIL",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_REPORT_FINDINGS",
  "CLAUDE_CODE_TERMINAL_MCP_TOOLS",
  "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
  "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  "CLAUDE_CODE_EAGER_FLUSH",
  "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
];

export function stripAppEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of Object.keys(out)) if (key.startsWith("AGENT_NAV_") || key.startsWith("ELECTRON_")) delete out[key];
  for (const key of DROPPED_ENV) delete out[key];
  return out;
}

const PROVIDER_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
let providerEnvAllowed = false;

export function allowProviderEnv(allowed: boolean) {
  providerEnvAllowed = allowed;
}

export const isProviderEnvAllowed = () => providerEnvAllowed;

export function claudeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out = stripAppEnv(env);
  out.PATH = withLoginPath(out.PATH);
  out.CLAUDE_AGENT_SDK_CLIENT_APP = `agent-nav/${APP_VERSION}`;
  if (!providerEnvAllowed) for (const key of PROVIDER_ENV_KEYS) delete out[key];
  return out;
}

export function isAuthError(text: string) {
  return /oauth|not logged in|login|authentication|unauthorized|401|expired/i.test(text);
}

export function mcpServerConfig(name: string): Record<string, unknown> | null {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
    const server = config.mcpServers?.[name];
    return server && typeof server === "object" ? server : null;
  } catch {
    return null;
  }
}
