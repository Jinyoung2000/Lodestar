// 자리를 비운 사이 앱이 스스로 새 소스를 반영하는 판단. 부수효과 없이 사실(facts)만 보고 다음 단계를 정한다. test/idleupdate.test.ts 가 확인한다.
// 설치된 앱은 데몬과 화면을 레포의 빌드(dist/, dist-electron/daemon.mjs)로 띄우고(electron/main.ts 의 pickRuntime), 앱 본체(main.mjs, preload.cjs)만 설치본 것을 쓴다. 그래서
// 1. 소스가 레포 빌드보다 새로우면 빌드한다(npm run build).
// 2. 빌드한 앱 본체가 설치본과 다르면 앱을 다시 묶고(electron-builder) 설치본을 갈아 끼운다.
// 3. 앱 본체는 같고 데몬이나 화면만 바뀌었으면 데몬만 다시 띄운다(창은 다시 읽는다).

export const BUILD_IDLE_SECONDS = 5 * 60; // lint-tokens: allow 입력이 이만큼 없을 때만 빌드를 시작한다(초)
export const APPLY_IDLE_SECONDS = 10 * 60; // lint-tokens: allow 입력이 이만큼 없을 때만 앱이나 데몬을 다시 띄운다(초)
export const SOURCE_QUIET_SECONDS = 2 * 60; // lint-tokens: allow 소스가 이만큼 바뀌지 않아야 빌드한다(작업 중인 반쯤 된 변경을 내보내지 않는다)(초)
export const RETRY_MS = 30 * 60_000; // lint-tokens: allow 같은 소스로 한 단계가 실패하면 이만큼 쉰다(ms)

export type IdleUpdateStepName = "build" | "package" | "install" | "restart";

export type IdleUpdateFacts = {
  enabled: boolean;
  // 도는 세션, 검사 중인 피드백 등
  busy: number;
  idleSeconds: number;
  now: number;
  // 지금 소스의 지문과 가장 최근 수정 시각(ms). 레포 빌드(dist-electron/build-stamp.json)가 어떤 소스에서 나왔는지.
  source: string | null;
  sourceChangedAt: number;
  repoBuilt: string | null;
  // 레포 빌드의 앱 본체가 설치본과 다른가, 묶어 둔 앱(release/)의 앱 본체가 레포 빌드와 같은가
  appChanged: boolean;
  packaged: boolean;
  // 레포 빌드가 지금 데몬이 뜬 뒤에 만들어졌는가
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
