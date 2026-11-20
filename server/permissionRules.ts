export const EDIT_TOOL_NAMES = ["Write", "Edit", "MultiEdit", "NotebookEdit"] as const;

export function sessionAllowRules(toolName: string): { toolName: string }[] {
  return (EDIT_TOOL_NAMES as readonly string[]).includes(toolName) ? EDIT_TOOL_NAMES.map((name) => ({ toolName: name })) : [{ toolName }];
}
