
export type FailureKind = "environment" | "auth" | "network" | "code";

export const ENV_RETRY_DELAYS_MS = [60_000, 300_000, 900_000];
export const AUTH_MAX_RETRIES = 3;
export const AUTH_PROBE_MS = 120_000;

export type FailureFacts = {
  code?: string | number | null;
  syscall?: string | null;
  text: string;
};

const AUTH_TEXT = /Failed to authenticate|OAuth session expired|could not be refreshed|authentication_failed|oauth_org_not_allowed|invalid x-api-key|Not logged in|Please run \/login/i;
const ENV_TEXT: RegExp[] = [
  /\bspawn \S+ ENOENT\b/,
  /(^|\n)\s*(?:sh|bash|zsh|dash): (?:\d+: )?[^\n:]+: (?:command )?not found/,
  /\bcommand not found\b/,
  /\benv: ['"‘]?node['"’]?: No such file or directory/,
  /\bnpm: (?:command )?not found\b/,
];
const NETWORK_TEXT = /\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b|getaddrinfo|npm (?:ERR!|error) network/i;
const SESSION_CONNECT_TEXT = /Unable to connect to API|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|fetch failed|socket hang up|network error/i;

export function classifyFailure(facts: FailureFacts): FailureKind {
  const { code, syscall, text } = facts;
  if (AUTH_TEXT.test(text)) return "auth";
  if (code === "ENOENT" && (syscall ? syscall.startsWith("spawn") : /\bspawn\b/.test(text))) return "environment";
  if (code === 127) return "environment";
  if (ENV_TEXT.some((pattern) => pattern.test(text))) return "environment";
  if (NETWORK_TEXT.test(text)) return "network";
  return "code";
}

export function classifySessionError(error: { text: string; auth?: boolean } | null): "auth" | "network" | "other" {
  if (!error) return "other";
  if (error.auth === true || AUTH_TEXT.test(error.text)) return "auth";
  return SESSION_CONNECT_TEXT.test(error.text) ? "network" : "other";
}

export function missingTool(text: string): string | null {
  const spawned = /\bspawn (\S+) ENOENT\b/.exec(text)?.[1];
  if (spawned) return spawned.split("/").pop() ?? spawned;
  const shell = /(?:^|\n)\s*(?:sh|bash|zsh|dash): (?:\d+: )?([^\s:]+): (?:command )?not found/.exec(text)?.[1];
  if (shell) return shell;
  const env = /\benv: ['"‘]?(\S+?)['"’]?: No such file or directory/.exec(text)?.[1];
  return env ?? null;
}

export function envRetryDelay(retriesDone: number, delays: readonly number[] = ENV_RETRY_DELAYS_MS): number | null {
  return retriesDone < delays.length ? delays[retriesDone] : null;
}

export function authRetriesLeft(retriesDone: number, max = AUTH_MAX_RETRIES): boolean {
  return retriesDone < max;
}

export function endedInSessionError(failure: string | null | undefined): boolean {
  return (failure ?? "").startsWith("The improvement session ended with an error");
}
