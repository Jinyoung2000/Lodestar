// 편집 승인 카드가 보일 변경 미리보기를 만드는 순수 함수들. 시험: test/approvalpreview.test.ts

export type EditPreview = {
  path: string;
  before: string;
  after: string;
  // 파일이 아직 없어 이 호출이 새로 만든다
  isNew: boolean;
};

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

export const isEditApproval = (toolName: string) => EDIT_TOOLS.has(toolName);

export function targetPath(input: Record<string, unknown>) {
  return typeof input.file_path === "string" ? input.file_path : null;
}

// current 는 승인을 묻는 지금 디스크의 내용(없는 파일이면 null, 읽지 못했으면 undefined).
// 읽은 내용이 있으면 파일 전체에 변경을 적용한 결과를 비교하고(앞뒤 문맥과 실제 줄 번호가 보인다), 못 읽었거나 바꿀 문자열을 못 찾으면 바꾸는 조각끼리만 비교한다.
export function previewEdit(toolName: string, input: Record<string, unknown>, current: string | null | undefined): EditPreview | null {
  const path = targetPath(input);
  if (path === null || !EDIT_TOOLS.has(toolName)) return null;
  if (toolName === "Write") {
    if (typeof input.content !== "string") return null;
    return { path, before: current ?? "", after: input.content, isNew: current === null };
  }
  const edits = toolName === "MultiEdit" ? multiEdits(input) : singleEdit(input);
  if (!edits || edits.length === 0) return null;
  if (typeof current === "string") {
    const applied = applyEdits(current, edits);
    if (applied !== null) return { path, before: current, after: applied, isNew: false };
  }
  return { path, before: edits.map((e) => e.oldString).join("\n"), after: edits.map((e) => e.newString).join("\n"), isNew: false };
}

type OneEdit = { oldString: string; newString: string; replaceAll: boolean };

function singleEdit(input: Record<string, unknown>): OneEdit[] | null {
  const one = editOf(input);
  return one ? [one] : null;
}

function multiEdits(input: Record<string, unknown>): OneEdit[] | null {
  if (!Array.isArray(input.edits)) return null;
  const edits: OneEdit[] = [];
  for (const raw of input.edits) {
    const one = raw && typeof raw === "object" ? editOf(raw as Record<string, unknown>) : null;
    if (!one) return null;
    edits.push(one);
  }
  return edits;
}

function editOf(input: Record<string, unknown>): OneEdit | null {
  if (typeof input.old_string !== "string" || typeof input.new_string !== "string") return null;
  return { oldString: input.old_string, newString: input.new_string, replaceAll: input.replace_all === true };
}

// 순서대로 적용한다. 바꿀 문자열이 없으면 null(도구도 이때 실패한다).
function applyEdits(text: string, edits: OneEdit[]): string | null {
  let out = text;
  for (const { oldString, newString, replaceAll } of edits) {
    if (oldString === "" || !out.includes(oldString)) return null;
    out = replaceAll ? out.split(oldString).join(newString) : out.replace(oldString, () => newString);
  }
  return out;
}
