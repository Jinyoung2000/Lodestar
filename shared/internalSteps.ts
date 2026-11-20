// fixB: 모델이 스스로 하는 준비 동작이라 사용자 단계 목록에서 숨기는 도구 호출.
// - ToolSearch: 모델이 도구 정의를 불러오는 호출(`select:ExitPlanMode` 등)
// - 계획 파일(~/.claude/plans/*.md) 읽기, 쓰기, 고치기: 계획은 승인 카드가 보여 준다
// 숨기는 것은 화면뿐이고 타임라인 기록은 그대로다. 실패한 호출은 숨기지 않는다.
const PLAN_FILE = /(^|\/)\.claude\/plans\/[^/]+\.md$/;
const PLAN_FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "Read"]);

export function isInternalStep(name: string, input: Record<string, unknown>, status: "running" | "done" | "error"): boolean {
  if (status === "error") return false;
  if (name === "ToolSearch") return true;
  if (!PLAN_FILE_TOOLS.has(name)) return false;
  const path = typeof input.file_path === "string" ? input.file_path : "";
  return PLAN_FILE.test(path);
}
