const PLAN_FILE = /(^|\/)\.claude\/plans\/[^/]+\.md$/;
const PLAN_FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "Read"]);

export function isInternalStep(name: string, input: Record<string, unknown>, status: "running" | "done" | "error"): boolean {
  if (status === "error") return false;
  if (name === "ToolSearch") return true;
  if (!PLAN_FILE_TOOLS.has(name)) return false;
  const path = typeof input.file_path === "string" ? input.file_path : "";
  return PLAN_FILE.test(path);
}
