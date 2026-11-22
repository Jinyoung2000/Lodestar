import { isAbsolute, join } from "node:path";
import type { TimelineItem, TurnChanges } from "../../shared/protocol";
import type { CodexFileChange, CodexPlanStep, CodexThreadItem, CodexTurn } from "./types";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
type PermissionTimelineItem = Extract<TimelineItem, { kind: "permission" }>;

export type MapContext = {
  cwd: string;
  interrupted?: boolean;
  at?: string;
};

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const MAX_OUTPUT = 20_000;

export const absolutePath = (cwd: string, path: string) => (isAbsolute(path) ? path : join(cwd, path));

export function displayCommand(command: string): string {
  const wrapped = /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim());
  if (!wrapped) return command;
  const inner = wrapped[2];
  return wrapped[1] === '"' ? inner.replace(/\\(["\\$`])/g, "$1") : inner;
}

export function diffHunks(diff: string): { oldString: string; newString: string }[] {
  const hunks: { oldLines: string[]; newLines: string[]; noEol: boolean }[] = [];
  let current: { oldLines: string[]; newLines: string[]; noEol: boolean } | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      current = { oldLines: [], newLines: [], noEol: false };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\")) {
      current.noEol = true;
      continue;
    }
    if (line.startsWith("+")) current.newLines.push(line.slice(1));
    else if (line.startsWith("-")) current.oldLines.push(line.slice(1));
    else if (line.startsWith(" ")) {
      current.oldLines.push(line.slice(1));
      current.newLines.push(line.slice(1));
    }
  }
  const join = (lines: string[], noEol: boolean) => (lines.length === 0 ? "" : lines.join("\n") + (noEol ? "" : "\n"));
  return hunks.map((h) => ({ oldString: join(h.oldLines, h.noEol), newString: join(h.newLines, h.noEol) }));
}

const looksUnified = (diff: string) => /^(@@|---|diff --git)/m.test(diff);

// add 의 diff 는 파일 내용이고, update 의 diff 는 unified diff 다(앱 서버 0.163.0). 모양이 다르면 가능한 만큼만 보인다.
export function editToolOf(change: CodexFileChange, cwd: string): { name: "Write" | "Edit" | "MultiEdit"; input: Record<string, unknown> } {
  const file_path = absolutePath(cwd, change.path);
  const kind = change.kind?.type;
  if (kind === "add") {
    const content = looksUnified(change.diff) ? diffHunks(change.diff).map((h) => h.newString).join("\n") : change.diff;
    return { name: "Write", input: { file_path, content } };
  }
  if (kind === "delete") {
    const old_string = looksUnified(change.diff) ? diffHunks(change.diff).map((h) => h.oldString).join("\n") : change.diff;
    return { name: "Edit", input: { file_path, old_string, new_string: "" } };
  }
  const hunks = diffHunks(change.diff);
  const move = change.kind?.move_path ? { moved_to: absolutePath(cwd, change.kind.move_path) } : {};
  if (hunks.length === 0) return { name: "Edit", input: { file_path, old_string: "", new_string: change.diff, ...move } };
  if (hunks.length === 1) return { name: "Edit", input: { file_path, old_string: hunks[0].oldString, new_string: hunks[0].newString, ...move } };
  return { name: "MultiEdit", input: { file_path, edits: hunks.map((h) => ({ old_string: h.oldString, new_string: h.newString })), ...move } };
}

export function fileChangeToolIds(item: CodexThreadItem): string[] {
  const changes = (item.changes as CodexFileChange[] | undefined) ?? [];
  return changes.length <= 1 ? [item.id] : changes.map((_, index) => `${item.id}:${index}`);
}

const truncate = (text: string) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n... (truncated)` : text);

function toolStatus(status: unknown, ctx: MapContext): Pick<ToolItem, "status"> & { cancelled?: true } {
  if (status === "inProgress") return { status: "running" };
  if (status === "completed") return { status: "done" };
  if (status === "declined") return { status: "error", cancelled: true };
  return { status: "error", ...(ctx.interrupted ? { cancelled: true as const } : {}) };
}

export function mcpResultText(result: unknown, error: unknown): string {
  const message = error && typeof error === "object" ? str((error as { message?: unknown }).message) : null;
  if (message) return message;
  const content = result && typeof result === "object" ? (result as { content?: unknown }).content : null;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string" ? (part as { text: string }).text : JSON.stringify(part)))
    .join("\n");
}

export function itemToTimeline(item: CodexThreadItem, phase: "started" | "completed", ctx: MapContext): TimelineItem[] {
  switch (item.type) {
    case "agentMessage": {
      const text = str(item.text) ?? "";
      if (phase === "started" && !text) return [];
      return [{ id: item.id, kind: "assistant", text, streaming: phase === "started", ...(phase === "completed" ? { at: ctx.at ?? new Date().toISOString() } : {}) }];
    }
    case "reasoning": {
      const summary = (item.summary as string[] | undefined) ?? [];
      const content = (item.content as string[] | undefined) ?? [];
      const text = (summary.length ? summary : content).join("\n\n").trim();
      return text ? [{ id: item.id, kind: "thinking", text }] : [];
    }
    case "commandExecution": {
      const command = displayCommand(str(item.command) ?? "");
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      const base = toolStatus(item.status, ctx);
      const failed = base.status === "done" && exitCode !== null && exitCode !== 0;
      const output = str(item.aggregatedOutput);
      return [
        {
          id: item.id,
          kind: "tool",
          name: "Bash",
          input: { command, ...(str(item.cwd) ? { cwd: str(item.cwd) } : {}) },
          ...base,
          ...(failed ? { status: "error" as const } : {}),
          output: phase === "started" && output === null ? null : truncate(`${output ?? ""}${failed ? `${output ? "\n" : ""}Exit code ${exitCode}` : ""}`),
        },
      ];
    }
    case "fileChange": {
      const changes = (item.changes as CodexFileChange[] | undefined) ?? [];
      const ids = fileChangeToolIds(item);
      const base = toolStatus(item.status, ctx);
      return changes.map((change, index) => {
        const { name, input } = editToolOf(change, ctx.cwd);
        return { id: ids[index], kind: "tool" as const, name, input, ...base, output: base.status === "done" ? (name === "Write" ? "File created successfully" : "File updated successfully") : null };
      });
    }
    case "mcpToolCall": {
      const args = item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments) ? (item.arguments as Record<string, unknown>) : {};
      const base = toolStatus(item.status, ctx);
      return [{ id: item.id, kind: "tool", name: `mcp__${str(item.server) ?? "mcp"}__${str(item.tool) ?? "tool"}`, input: args, ...base, output: phase === "started" ? null : truncate(mcpResultText(item.result, item.error)) }];
    }
    case "dynamicToolCall": {
      const args = item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments) ? (item.arguments as Record<string, unknown>) : {};
      const items = Array.isArray(item.contentItems) ? (item.contentItems as { text?: unknown }[]).map((c) => str(c.text) ?? "").filter(Boolean).join("\n") : "";
      const name = [str(item.namespace), str(item.tool)].filter(Boolean).join("__") || "tool";
      return [{ id: item.id, kind: "tool", name, input: args, ...toolStatus(item.status, ctx), output: phase === "started" ? null : truncate(items) }];
    }
    case "webSearch": {
      const action = item.action as { type?: string; query?: string | null; queries?: string[] | null; url?: string | null } | undefined;
      const query = [str(item.query), action?.query, action?.queries?.join(", "), action?.url].find((q) => !!q) ?? "";
      return [{ id: item.id, kind: "tool", name: "WebSearch", input: { query }, status: phase === "started" ? "running" : "done", output: null }];
    }
    case "imageView": {
      const path = str(item.path);
      return path ? [{ id: item.id, kind: "tool", name: "Read", input: { file_path: absolutePath(ctx.cwd, path) }, status: phase === "started" ? "running" : "done", output: null }] : [];
    }
    case "collabAgentToolCall":
    case "subAgentActivity": {
      const tool = str(item.tool) ?? str(item.kind) ?? "agent";
      return [{ id: item.id, kind: "tool", name: `codex_${tool}`, input: { ...(str(item.prompt) ? { description: str(item.prompt) } : {}) }, ...toolStatus(item.status ?? (phase === "started" ? "inProgress" : "completed"), ctx), output: null }];
    }
    case "contextCompaction":
      return phase === "completed" ? [{ id: item.id, kind: "notice", text: "Context compacted" }] : [];
    default:
      return [];
  }
}

export function planToTool(turnId: string, steps: CodexPlanStep[]): ToolItem {
  const todos = steps.map((s) => ({ content: s.step, activeForm: s.step, status: s.status === "inProgress" ? "in_progress" : s.status }));
  return { id: `plan:${turnId}`, kind: "tool", name: "TodoWrite", input: { todos }, status: "done", output: null };
}

export function commandApproval(requestId: string | number, params: Record<string, unknown>, itemId: string): PermissionTimelineItem {
  const command = displayCommand(str(params.command) ?? "");
  const reason = str(params.reason);
  const cwd = str(params.cwd);
  return {
    id: `codex-approval:${requestId}`,
    kind: "permission",
    toolUseId: itemId,
    toolName: "Bash",
    input: { command, ...(reason ? { description: reason } : {}), ...(cwd ? { cwd } : {}) },
    status: "pending",
  };
}

// 파일 변경 승인 요청 -> Edit, Write, MultiEdit 승인 카드. 요청은 itemId 만 알려 주므로 item/started 때 받아 둔 변경에서 카드 내용을 만든다.
export function fileChangeApproval(requestId: string | number, params: Record<string, unknown>, item: CodexThreadItem | undefined, cwd: string): PermissionTimelineItem {
  const changes = (item?.changes as CodexFileChange[] | undefined) ?? [];
  const reason = str(params.reason);
  const first = changes[0] ? editToolOf(changes[0], cwd) : null;
  const others = changes.slice(1).map((c) => absolutePath(cwd, c.path));
  const ids = item ? fileChangeToolIds(item) : [str(params.itemId) ?? ""];
  return {
    id: `codex-approval:${requestId}`,
    kind: "permission",
    toolUseId: ids[0],
    toolName: first?.name ?? "Edit",
    input: { ...(first?.input ?? {}), ...(reason ? { description: reason } : {}), ...(others.length ? { other_files: others } : {}) },
    status: "pending",
  };
}

const diffPath = (raw: string) => raw.replace(/^[ab]\//, "").replace(/\t.*$/, "");

export function summarizeDiff(diff: string, cwd: string): TurnChanges | undefined {
  const files = new Map<string, { additions: number; deletions: number }>();
  let current: { additions: number; deletions: number } | null = null;
  let oldPath: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      oldPath = line.slice(4).trim() === "/dev/null" ? null : diffPath(line.slice(4).trim());
      current = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      const path = raw === "/dev/null" ? oldPath : diffPath(raw);
      if (!path) continue;
      current = files.get(path) ?? { additions: 0, deletions: 0 };
      files.set(path, current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) current.additions += 1;
    else if (line.startsWith("-")) current.deletions += 1;
  }
  if (files.size === 0) return undefined;
  const list = [...files].map(([path, count]) => ({ path: absolutePath(cwd, path), ...count }));
  return { files: list.length, additions: list.reduce((n, f) => n + f.additions, 0), deletions: list.reduce((n, f) => n + f.deletions, 0), list };
}

// 모델 API 오류는 {"type":"error","status":400,"error":{"message":...}} 같은 JSON 글로 오므로 안쪽 message 만 꺼내 보인다(실제 Codex 0.163.0 에서 확인).
export function turnErrorOf(error: CodexTurn["error"] | undefined): { text: string; auth: boolean } {
  const message = unwrapApiError(error?.message?.trim() || "") || "Codex turn failed";
  const info = error?.codexErrorInfo;
  const auth = info === "unauthorized" || /not logged in|log in|login required|401/i.test(message);
  const detail = error?.additionalDetails?.trim();
  return { text: detail && !message.includes(detail) ? `${message}\n${detail}` : message, auth };
}

function unwrapApiError(message: string): string {
  if (!message.startsWith("{")) return message;
  try {
    const parsed = JSON.parse(message) as { error?: { message?: unknown }; message?: unknown };
    const inner = parsed.error?.message ?? parsed.message;
    return typeof inner === "string" && inner.trim() ? inner.trim() : message;
  } catch {
    return message;
  }
}
