import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findExecutable, withLoginPath } from "./loginPath";
import { T } from "./strings";
import { version as APP_VERSION } from "../package.json";

// SDK 로 띄우는 모든 CLI 프로세스가 공유하는 설정.
export function claudeBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_NAV_CLAUDE) return env.AGENT_NAV_CLAUDE;
  const native = join(env.HOME ?? homedir(), ".local", "bin", "claude");
  if (findExecutable(native, undefined)) return native;
  return findExecutable("claude", withLoginPath(env.PATH)) ?? native;
}

export function claudeErrorText(text: string) {
  return /Claude Code (native binary|executable) not found|spawn \S*claude ENOENT/i.test(text) ? T.claudeNotInstalled : text;
}

// 데몬이 Claude Code 세션 안에서 떠도 자식 CLI 가 그 세션의 일부로 오인되지 않게, 상속받은 세션 변수를 뺀다.
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 은 Artifact 도구와 claude.ai 커넥터를 끄므로 절대 넘기지 않는다.
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
  // Claude 데스크톱 앱이 자기 세션에 넣는 값들. 앱을 그 세션에서 띄우면 데몬이 그대로 물려받는다(2026-10-15 실제로 확인).
  // OAUTH_TOKEN 은 추론 전용 토큰이라 넘기면 claude.ai 커넥터와 Artifact 가 막힌다. 넘기지 않으면 CLI 가 키체인 로그인을 쓴다.
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

// 앱 내부용 변수(AGENT_NAV_*, ELECTRON_*)는 에이전트 세션과 터미널로 넘기지 않는다.
// 넘어가면 세션 안에서 도는 npm test 가 설치 앱의 포트(AGENT_NAV_PORT)를 시험 대상으로 보고 멈추고, AGENT_NAV_ROOT 는 worktree 의 데몬이 앱 번들을 서빙하게 만든다.
// 사용자가 셸에 둔 다른 변수(PATH, HOME, 개인 토큰 등)는 그대로 둔다.
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

// MCP 서버 설정은 사용자의 Claude Code 설정(~/.claude.json 의 mcpServers)에 있는 것을 그대로 쓴다. 인증(OAuth)은 CLI 가 키체인에서 읽고, 토큰은 이 앱이 다루지 않는다.
// 서버가 설정에 없으면 null.
export function mcpServerConfig(name: string): Record<string, unknown> | null {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
    const server = config.mcpServers?.[name];
    return server && typeof server === "object" ? server : null;
  } catch {
    return null;
  }
}
