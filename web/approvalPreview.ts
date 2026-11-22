
export type EditPreview = {
  path: string;
  before: string;
  after: string;
  isNew: boolean;
};

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

export const isEditApproval = (toolName: string) => EDIT_TOOLS.has(toolName);

export function targetPath(input: Record<string, unknown>) {
  return typeof input.file_path === "string" ? input.file_path : null;
}

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

function applyEdits(text: string, edits: OneEdit[]): string | null {
  let out = text;
  for (const { oldString, newString, replaceAll } of edits) {
    if (oldString === "" || !out.includes(oldString)) return null;
    out = replaceAll ? out.split(oldString).join(newString) : out.replace(oldString, () => newString);
  }
  return out;
}
