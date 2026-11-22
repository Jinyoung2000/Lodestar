
export const BUILD_IDLE_SECONDS = 5 * 60; // lint-tokens: allow 입력이 이만큼 없을 때만 빌드를 시작한다(초)
export const APPLY_IDLE_SECONDS = 10 * 60; // lint-tokens: allow 입력이 이만큼 없을 때만 앱이나 데몬을 다시 띄운다(초)
export const SOURCE_QUIET_SECONDS = 2 * 60; // lint-tokens: allow 소스가 이만큼 바뀌지 않아야 빌드한다(작업 중인 반쯤 된 변경을 내보내지 않는다)(초)
export const RETRY_MS = 30 * 60_000; // lint-tokens: allow 같은 소스로 한 단계가 실패하면 이만큼 쉰다(ms)

export type IdleUpdateStepName = "build" | "package" | "install" | "restart";

export type IdleUpdateFacts = {
  enabled: boolean;
  busy: number;
  idleSeconds: number;
  now: number;
  source: string | null;
  sourceChangedAt: number;
  repoBuilt: string | null;
  appChanged: boolean;
  packaged: boolean;
  daemonStale: boolean;
  working: boolean;
  lastFailure: { at: number; step: IdleUpdateStepName; source: string } | null;
};

export type IdleUpdateStep = { step: "wait"; reason: string } | { step: IdleUpdateStepName };

export function idleUpdateStep(f: IdleUpdateFacts): IdleUpdateStep {
  if (!f.enabled) return { step: "wait", reason: "off" };
  if (f.working) return { step: "wait", reason: "in progress" };
  if (f.source === null) return { step: "wait", reason: "source unknown" };
  if (f.busy > 0) return { step: "wait", reason: "busy" };
  const failedRecently = (step: IdleUpdateStepName) => f.lastFailure !== null && f.lastFailure.step === step && f.lastFailure.source === f.source && f.now - f.lastFailure.at < RETRY_MS;
  const next = (step: IdleUpdateStepName, idle: number): IdleUpdateStep => {
    if (f.idleSeconds < idle) return { step: "wait", reason: "user active" };
    if (failedRecently(step)) return { step: "wait", reason: `${step} failed recently` };
    return { step };
  };
  if (f.repoBuilt !== f.source) {
    if (f.idleSeconds >= BUILD_IDLE_SECONDS && (f.now - f.sourceChangedAt) / 1000 < SOURCE_QUIET_SECONDS) return { step: "wait", reason: "source changing" };
    return next("build", BUILD_IDLE_SECONDS);
  }
  if (f.appChanged) return f.packaged ? next("install", APPLY_IDLE_SECONDS) : next("package", BUILD_IDLE_SECONDS);
  if (f.daemonStale) return next("restart", APPLY_IDLE_SECONDS);
  return { step: "wait", reason: "current" };
}
