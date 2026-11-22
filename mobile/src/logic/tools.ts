export type ToolLine = { verb: string; detail: string | null };

const VERBS: Record<string, string> = {
  Bash: "Ran",
  Read: "Read",
  Edit: "Edited",
  MultiEdit: "Edited",
  Write: "Wrote",
  Grep: "Searched",
  Glob: "Found",
  Agent: "Subagent",
  Task: "Subagent",
  WebFetch: "Fetched",
  WebSearch: "Searched the web",
  Skill: "Skill",
  TodoWrite: "Updated todos",
  AskUserQuestion: "Asked",
};

const BASE_VERBS: Record<string, string> = {
  Bash: "Run",
  Read: "Read",
  Edit: "Edit",
  MultiEdit: "Edit",
  Write: "Write",
  Grep: "Search",
  Glob: "Find",
  Agent: "Run subagent",
  Task: "Run subagent",
  WebFetch: "Fetch",
  WebSearch: "Search the web",
  Skill: "Use skill",
};

const str = (input: Record<string, unknown>, key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);

export function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : path;
}

function mcpName(name: string): string | null {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return match ? `${match[1]}: ${match[2]}` : null;
}

export function describeTool(name: string, input: Record<string, unknown> = {}, done = true): ToolLine {
  const verb = (done ? VERBS[name] : BASE_VERBS[name]) ?? mcpName(name) ?? name;
  switch (name) {
    case "Bash":
      return { verb, detail: (str(input, "command") ?? "").split("\n")[0].slice(0, 160) };
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write": {
      const path = str(input, "file_path");
      return { verb, detail: path ? shortPath(path) : null };
    }
    case "Grep":
      return { verb, detail: `${str(input, "pattern") ?? ""}${str(input, "path") ? ` in ${shortPath(str(input, "path")!)}` : ""}` };
    case "Glob":
      return { verb, detail: str(input, "pattern") };
    case "Agent":
    case "Task":
      return { verb, detail: str(input, "description") ?? str(input, "prompt")?.slice(0, 80) ?? null };
    case "WebFetch":
      return { verb, detail: str(input, "url") };
    case "WebSearch":
      return { verb, detail: str(input, "query") };
    case "Skill":
      return { verb, detail: str(input, "skill") };
    default: {
      const detail = str(input, "description") ?? str(input, "query") ?? JSON.stringify(input).slice(0, 100);
      return { verb, detail: detail === "{}" ? null : detail };
    }
  }
}

export function approvalTarget(name: string, input: Record<string, unknown>): { kind: "command" | "path" | "url" | "query"; text: string } | null {
  const command = str(input, "command");
  if (command) return { kind: "command", text: command };
  const url = str(input, "url");
  if (url) return { kind: "url", text: url };
  const query = str(input, "query");
  if (query) return { kind: "query", text: query };
  const path = str(input, "file_path");
  if (path) return { kind: "path", text: path };
  return name ? null : null;
}
