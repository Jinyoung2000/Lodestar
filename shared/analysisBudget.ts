export const ANALYSIS_BUDGET_USD = { haiku: 0.15, sonnet: 0.15, opus: 0.4 } as const;
// 설정에서 고를 수 있는 범위. 이 밖의 값은 설정이 거절한다.
export const ANALYSIS_BUDGET_MIN_USD = 0.05;
export const ANALYSIS_BUDGET_MAX_USD = 5;

// override 가 있으면 그 값, 없으면 모델별 기본값. 모르는 모델 이름은 sonnet 기준.
export function analysisBudgetUsd(model: string, override?: number | null): number {
  if (typeof override === "number" && Number.isFinite(override) && override >= ANALYSIS_BUDGET_MIN_USD && override <= ANALYSIS_BUDGET_MAX_USD) return override;
  const name = model.toLowerCase();
  return name.includes("opus") ? ANALYSIS_BUDGET_USD.opus : name.includes("haiku") ? ANALYSIS_BUDGET_USD.haiku : ANALYSIS_BUDGET_USD.sonnet;
}
