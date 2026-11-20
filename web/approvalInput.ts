// fixB: 승인 카드가 보일 대상 한 줄과, 그 줄과 겹치지 않는 나머지 입력.
// Fetch 는 URL, Search 는 질의, Bash 는 명령이 대상 줄에 나온다. 그 값이 카드에 다 보이면 아래 Input 에서는 뺀다(같은 글이 두 번 나오지 않게).
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
  // 카드 줄은 첫 줄 120자까지만 보인다. 그보다 길거나 여러 줄이면 전문이 Input 에 남아야 한다.
  const shown = command.split("\n")[0].slice(0, COMMAND_SHOWN_CHARS);
  const whole = shown === command;
  return { target: { kind: "command", text: shown }, rest: whole ? without("command") : input };
}

export function spacedJson(input: Record<string, unknown>) {
  const entries = Object.entries(input).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return entries.length ? `{ ${entries.join(", ")} }` : "{}";
}
