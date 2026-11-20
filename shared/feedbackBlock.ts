// FBBLOCK: 코드가 아니라 환경이나 인증 때문에 멈춘 피드백을 가려내는 판단. 코드로 고칠 수 없는 오류에 개선 세션의 자동 수정 턴을 쓰지 않게 한다.
// 시험: test/feedbackblocked.test.ts

export type FailureKind = "environment" | "auth" | "network" | "code";

// 환경 오류가 나면 PATH 를 다시 읽고 검사부터 다시 돈다. 이 간격(1분, 5분, 15분)을 다 쓰면 failed 로 바꾼다.
export const ENV_RETRY_DELAYS_MS = [60_000, 300_000, 900_000];
// 인증이 돌아온 것이 확인된 뒤 세션을 다시 시작하는 최대 횟수
export const AUTH_MAX_RETRIES = 3;
// 인증이 돌아왔는지 가볍게 보는 주기
export const AUTH_PROBE_MS = 120_000;

export type FailureFacts = {
  // 자식 프로세스가 시작하지 못했으면 "ENOENT" 같은 문자열, 종료 코드로 끝났으면 숫자
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
// 검사 출력에서 보는 네트워크 오류는 이름 해석과 도달 불가만 본다. ECONNREFUSED, ECONNRESET, fetch failed 는 피드백이 시험 데몬을 깨뜨려도 나오므로 코드 오류로 둔다.
const NETWORK_TEXT = /\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b|getaddrinfo|npm (?:ERR!|error) network/i;
// 개선 세션이 모델 서버에 닿지 못한 오류
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

// 개선 세션 타임라인의 마지막 오류가 인증 때문인가, 연결 때문인가
export function classifySessionError(error: { text: string; auth?: boolean } | null): "auth" | "network" | "other" {
  if (!error) return "other";
  if (error.auth === true || AUTH_TEXT.test(error.text)) return "auth";
  return SESSION_CONNECT_TEXT.test(error.text) ? "network" : "other";
}

// 출력에서 찾지 못한 실행 파일 이름
export function missingTool(text: string): string | null {
  const spawned = /\bspawn (\S+) ENOENT\b/.exec(text)?.[1];
  if (spawned) return spawned.split("/").pop() ?? spawned;
  const shell = /(?:^|\n)\s*(?:sh|bash|zsh|dash): (?:\d+: )?([^\s:]+): (?:command )?not found/.exec(text)?.[1];
  if (shell) return shell;
  const env = /\benv: ['"‘]?(\S+?)['"’]?: No such file or directory/.exec(text)?.[1];
  return env ?? null;
}

// 다음 자동 재시도까지 기다릴 시간. 이미 간격을 다 썼으면 null.
export function envRetryDelay(retriesDone: number, delays: readonly number[] = ENV_RETRY_DELAYS_MS): number | null {
  return retriesDone < delays.length ? delays[retriesDone] : null;
}

export function authRetriesLeft(retriesDone: number, max = AUTH_MAX_RETRIES): boolean {
  return retriesDone < max;
}

// 실패 문장이 개선 세션이 오류로 끝나서 생긴 것인가(상태에 표시를 남기기 전에 만들어진 항목도 Run Again 을 보이게 한다)
export function endedInSessionError(failure: string | null | undefined): boolean {
  return (failure ?? "").startsWith("The improvement session ended with an error");
}
