export type ApprovalTarget = { kind: "command" | "url" | "query"; text: string } | null;

const COMMAND_SHOWN_CHARS = 120;

export function approvalInputView(toolName: string, input: Record<string, unknown>): { target: ApprovalTarget; rest: Record<string, unknown> } {
  const without = (key: string) => Object.fromEntries(Object.entries(input).filter(([k]) => k !== key));
  const text = (key: string) => (typeof input[key] === "string" && (input[key] as string).trim() ? (input[key] as string) : null);
  if (toolName === "WebFetch") {
    const url = text("url");
    return url ? { target: { kind: "url", text: url }, rest: without("url") } : { target: null, rest: input };
  }
  if (toolName === "WebSearch") {
    const query = text("query");
    return query ? { target: { kind: "query", text: query }, rest: without("query") } : { target: null, rest: input };
  }
  const command = text("command");
  if (!command) return { target: null, rest: input };
  const shown = command.split("\n")[0].slice(0, COMMAND_SHOWN_CHARS);
  const whole = shown === command;
  return { target: { kind: "command", text: shown }, rest: whole ? without("command") : input };
}

export function spacedJson(input: Record<string, unknown>) {
  const entries = Object.entries(input).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return entries.length ? `{ ${entries.join(", ")} }` : "{}";
}
