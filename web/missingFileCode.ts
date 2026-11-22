
const MAX_SUGGESTIONS = 30;
const suggestions = new Map<string, string>();

const keyOf = (workspaceId: string, path: string) => `${workspaceId}\n${path}`;

export function rememberSuggestedCode(workspaceId: string, path: string, code: string) {
  const key = keyOf(workspaceId, path);
  suggestions.delete(key);
  suggestions.set(key, code);
  if (suggestions.size > MAX_SUGGESTIONS) suggestions.delete(suggestions.keys().next().value as string);
}

export function peekSuggestedCode(workspaceId: string, path: string): string | null {
  return suggestions.get(keyOf(workspaceId, path)) ?? null;
}

export function forgetSuggestedCode(workspaceId: string, path: string) {
  suggestions.delete(keyOf(workspaceId, path));
}

export function codeWithoutPathHeader(code: string, pathText: string): string | null {
  const lines = code.split("\n");
  const match = /^(?:\/\/+|#+|--|\/\*+|<!--)\s*(.+?)\s*(?:\*\/|-->)?$/.exec(lines[0].trim());
  if (!match) return null;
  const header = match[1].replace(/:\d+(?::\d+)?$/, "");
  const wanted = pathText.replace(/:\d+(?::\d+)?$/, "");
  if (header !== wanted && !header.endsWith(`/${wanted}`) && !wanted.endsWith(`/${header}`)) return null;
  return withTrailingNewline(lines.slice(1).join("\n").replace(/^\n+/, ""));
}

export function withTrailingNewline(code: string): string {
  return code === "" || code.endsWith("\n") ? code : `${code}\n`;
}
