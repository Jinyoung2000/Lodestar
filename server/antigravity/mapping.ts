import type { CodexModelInfo, EffortLevel, PermissionDecision, TimelineItem } from "../../shared/protocol";
import { EFFORT_LEVELS } from "../../shared/protocol";
import { absolutePath } from "../codex/mapping";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
type PermissionTimelineItem = Extract<TimelineItem, { kind: "permission" }>;

export type AcpToolContent =
  | { type: "content"; content?: { type?: string; text?: string } }
  | { type: "diff"; path?: string; oldText?: string | null; newText?: string }
  | { type: "terminal"; terminalId?: string }
  | { type: string; [key: string]: unknown };

export type AcpToolCall = {
  toolCallId: string;
  name?: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  args?: Record<string, unknown>;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: AcpToolContent[];
  locations?: { path?: string; line?: number }[];
};

export type AcpPermissionOption = { optionId: string; name?: string; kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string };

export type AcpPlanEntry = { content?: string; priority?: string; status?: "pending" | "in_progress" | "completed" };

export type AcpConfigOption = { id?: string; name?: string; category?: string; currentValue?: string; options?: { value?: string; name?: string }[] };

export type MapContext = { cwd: string; interrupted?: boolean };

const MAX_OUTPUT = 20_000;
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const truncate = (text: string) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n... (truncated)` : text);

export function mergeToolCall(previous: AcpToolCall | undefined, update: Partial<AcpToolCall> & { toolCallId: string }): AcpToolCall {
  const next: AcpToolCall = { ...(previous ?? { toolCallId: update.toolCallId }) };
  for (const [key, value] of Object.entries(update)) if (value !== undefined && value !== null && key !== "sessionUpdate") (next as Record<string, unknown>)[key] = value;
  return next;
}

function argsOf(call: AcpToolCall): Record<string, unknown> {
  if (call.args && typeof call.args === "object") return call.args;
  if (call.rawInput && typeof call.rawInput === "object" && !Array.isArray(call.rawInput)) return call.rawInput as Record<string, unknown>;
  return {};
}

function pathOf(call: AcpToolCall, args: Record<string, unknown>, cwd: string): string | null {
  const raw = str(call.locations?.[0]?.path) ?? str(args.Path) ?? str(args.TargetFile) ?? str(args.AbsolutePath) ?? str(args.FilePath) ?? str(args.File) ?? str(args.path);
  return raw ? absolutePath(cwd, raw) : null;
}

function diffsOf(call: AcpToolCall) {
  return (call.content ?? []).filter((c): c is { type: "diff"; path?: string; oldText?: string | null; newText?: string } => c.type === "diff");
}

function textOf(call: AcpToolCall): string {
  return (call.content ?? [])
    .map((c) => (c.type === "content" && c.content && typeof c.content === "object" && typeof (c.content as { text?: unknown }).text === "string" ? (c.content as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

const isExecute = (call: AcpToolCall) => call.kind === "execute" || call.name === "run_command";
const isEdit = (call: AcpToolCall) => call.kind === "edit" || call.kind === "delete" || call.kind === "move" || /^(write_to_file|write_file|replace_file_content|multi_replace_file_content|sed_file)$/.test(call.name ?? "");

function editTool(call: AcpToolCall, args: Record<string, unknown>, cwd: string): { name: "Write" | "Edit" | "MultiEdit"; input: Record<string, unknown> } {
  const diffs = diffsOf(call);
  const file_path = (diffs[0]?.path ? absolutePath(cwd, diffs[0].path) : null) ?? pathOf(call, args, cwd) ?? "";
  if (args.Append === true && !diffs.some((d) => typeof d.oldText === "string")) return { name: "Edit", input: { file_path, old_string: "", new_string: diffs[0]?.newText ?? str(args.Content) ?? "", append: true } };
  if (diffs.length === 1 &&(diffs[0].oldText === undefined || diffs[0].oldText === null)) return { name: "Write", input: { file_path, content: diffs[0].newText ?? "" } };
  if (diffs.length === 1) return { name: "Edit", input: { file_path, old_string: diffs[0].oldText ?? "", new_string: diffs[0].newText ?? "" } };
  if (diffs.length > 1) return { name: "MultiEdit", input: { file_path, edits: diffs.map((d) => ({ old_string: d.oldText ?? "", new_string: d.newText ?? "" })) } };
  if (/^(write_to_file|write_file)$/.test(call.name ?? "")) return { name: "Write", input: { file_path, content: str(args.Content) ?? str(args.CodeContent) ?? "" } };
  const chunks = Array.isArray(args.ReplacementChunks) ? (args.ReplacementChunks as Record<string, unknown>[]) : null;
  if (chunks?.length) return { name: "MultiEdit", input: { file_path, edits: chunks.map((c) => ({ old_string: str(c.TargetContent) ?? "", new_string: str(c.ReplacementContent) ?? "" })) } };
  return { name: "Edit", input: { file_path, old_string: str(args.TargetContent) ?? "", new_string: str(args.ReplacementContent) ?? "" } };
}

const unquote = (text: string) => (/^`[^`]*`$/.test(text) ? text.slice(1, -1) : text);

export function isHiddenTool(call: AcpToolCall) {
  const name = argsOf(call)._toolName;
  return name === "updateTodos" || name === "createPlan";
}

function cursorTool(call: AcpToolCall, args: Record<string, unknown>, title: string | null, cwd: string): { name: string; input: Record<string, unknown> } | null {
  if (args._toolName === "task") return { name: "Task", input: { description: str(args.description) ?? title ?? "", prompt: str(args.prompt) ?? "", ...(str(args.subagentType) ? { subagent_type: str(args.subagentType) } : {}) } };
  if (str(args.providerIdentifier) && str(args.toolName)) {
    const inner = args.args && typeof args.args === "object" && !Array.isArray(args.args) ? (args.args as Record<string, unknown>) : {};
    return { name: `mcp__${str(args.providerIdentifier)}__${str(args.toolName)}`, input: inner };
  }
  if (str(args.searchTerm)) return { name: "WebSearch", input: { query: str(args.searchTerm) } };
  if (str(args.url) && call.kind === "fetch") return { name: "WebFetch", input: { url: str(args.url) } };
  if (str(args.pattern) && title?.startsWith("grep")) return { name: "Grep", input: { pattern: str(args.pattern), ...(str(args.path) ? { path: absolutePath(cwd, str(args.path)!) } : {}) } };
  if (str(args.pattern) && call.kind === "search") return { name: "Glob", input: { pattern: str(args.pattern) } };
  if (str(args.path) && title?.startsWith("List the")) return { name: "LS", input: { path: absolutePath(cwd, str(args.path)!) } };
  return null;
}

export function toolOf(call: AcpToolCall, cwd: string): { name: string; input: Record<string, unknown> } {
  const args = argsOf(call);
  const title = str(call.title);
  if (isExecute(call)) {
    const description = str(args.toolSummary);
    const dir = str(args.Cwd);
    return { name: "Bash", input: { command: str(args.CommandLine) ?? str(args.command) ?? (title ? unquote(title) : ""), ...(description ? { description } : {}), ...(dir ? { cwd: dir } : {}) } };
  }
  const cursor = cursorTool(call, args, title, cwd);
  if (cursor) return cursor;
  if (isEdit(call)) return editTool(call, args, cwd);
  if (call.name === "view_file" || (call.kind === "read" && pathOf(call, args, cwd))) return { name: "Read", input: { file_path: pathOf(call, args, cwd) ?? title ?? "" } };
  if (call.name === "list_dir") return { name: "LS", input: { path: str(args.DirectoryPath) ?? pathOf(call, args, cwd) ?? cwd } };
  if (call.name === "grep_search") return { name: "Grep", input: { pattern: str(args.Query) ?? str(args.Pattern) ?? title ?? "", ...(str(args.SearchPath) ? { path: str(args.SearchPath) } : {}) } };
  if (call.name === "find_by_name") return { name: "Glob", input: { pattern: str(args.Pattern) ?? title ?? "", ...(str(args.SearchDirectory) ? { path: str(args.SearchDirectory) } : {}) } };
  if (call.name === "search_web") return { name: "WebSearch", input: { query: str(args.query) ?? str(args.Query) ?? title ?? "" } };
  if (call.name === "read_url_content") return { name: "WebFetch", input: { url: str(args.Url) ?? str(args.url) ?? title ?? "" } };
  if (call.name === "call_mcp_tool" && str(args.ServerName) && str(args.ToolName)) {
    const inner = args.Arguments && typeof args.Arguments === "object" && !Array.isArray(args.Arguments) ? (args.Arguments as Record<string, unknown>) : {};
    return { name: `mcp__${str(args.ServerName)}__${str(args.ToolName)}`, input: inner };
  }
  return { name: str(call.name) ?? call.kind ?? "tool", input: { ...args, ...(title && !("description" in args) ? { description: title } : {}) } };
}

export function commandOutput(raw: string): string {
  const marker = raw.indexOf("Command output:\n");
  if (marker !== -1) return raw.slice(marker + "Command output:\n".length).replace(/\r\n/g, "\n");
  if (/\nNo output from the command\.?\s*$/.test(raw) || /^No output from the command/.test(raw)) return "";
  return raw.replace(/\r\n/g, "\n");
}

function rawOutputText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return null;
  const output = (raw as { output?: unknown }).output;
  if (typeof output === "string") return output;
  const { stdout, stderr, content, totalMatches, totalFiles } = raw as { stdout?: unknown; stderr?: unknown; content?: unknown; totalMatches?: unknown; totalFiles?: unknown };
  if (typeof totalMatches === "number") return `${totalMatches} ${totalMatches === 1 ? "match" : "matches"}`;
  if (typeof totalFiles === "number") return `${totalFiles} ${totalFiles === 1 ? "file" : "files"}`;
  if (typeof stdout === "string" || typeof stderr === "string") return [stdout, stderr].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
  if (typeof content === "string") return content;
  const keys = Object.keys(raw);
  return keys.length ? JSON.stringify(raw) : null;
}

function exitCodeOf(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const code = (raw as { exit_code?: unknown; exitCode?: unknown }).exit_code ?? (raw as { exitCode?: unknown }).exitCode;
  return typeof code === "number" ? code : null;
}

export function toolToTimeline(call: AcpToolCall, ctx: MapContext): ToolItem {
  const { name, input } = toolOf(call, ctx.cwd);
  const finished = call.status === "completed" || call.status === "failed";
  const base: Pick<ToolItem, "status"> & { cancelled?: true } =
    call.status === "completed" ? { status: "done" } : call.status === "failed" ? { status: "error", ...(ctx.interrupted ? { cancelled: true as const } : {}) } : { status: "running" };
  if (!finished) return { id: call.toolCallId, kind: "tool", name, input, ...base, output: null };
  if (name === "Bash") {
    const raw = rawOutputText(call.rawOutput) ?? textOf(call);
    const text = commandOutput(raw);
    const code = exitCodeOf(call.rawOutput);
    const failed = base.status === "done" && code !== null && code !== 0;
    return { id: call.toolCallId, kind: "tool", name, input, ...base, ...(failed ? { status: "error" as const } : {}), output: truncate(`${text}${failed ? `${text ? "\n" : ""}Exit code ${code}` : ""}`) };
  }
  if (name === "Write" || name === "Edit" || name === "MultiEdit") {
    const output = base.status === "done" ? (name === "Write" ? "File created successfully" : "File updated successfully") : (textOf(call) || rawOutputText(call.rawOutput) || null);
    return { id: call.toolCallId, kind: "tool", name, input, ...base, output };
  }
  const output = textOf(call) || rawOutputText(call.rawOutput) || "";
  return { id: call.toolCallId, kind: "tool", name, input, ...base, output: truncate(output) };
}

export function permissionCard(cardId: string, call: AcpToolCall, cwd: string): PermissionTimelineItem {
  const { name, input } = toolOf(call, cwd);
  return { id: cardId, kind: "permission", toolUseId: call.toolCallId, toolName: name, input, status: "pending" };
}

export function chooseOption(options: AcpPermissionOption[], decision: PermissionDecision): string | null {
  const byKind = (...kinds: string[]) => kinds.map((kind) => options.find((o) => o.kind === kind)).find((o) => o !== undefined)?.optionId ?? null;
  if (decision === "allowAlways") return byKind("allow_always", "allow_once");
  if (decision === "allow") return byKind("allow_once", "allow_always");
  return byKind("reject_once", "reject_always");
}

export function planToTool(id: string, entries: AcpPlanEntry[]): ToolItem {
  const todos = entries.map((e) => ({ content: e.content ?? "", activeForm: e.content ?? "", status: e.status ?? "pending" }));
  return { id, kind: "tool", name: "TodoWrite", input: { todos }, status: "done", output: null };
}

const LEVEL_SUFFIX = /^(.*)-(low|medium|high|xhigh|max)$/;
const LEVEL_LABEL = /\s*\((low|medium|high|xhigh|extra|max)\)\s*$/i;

export function parseAgyModels(text: string): CodexModelInfo[] {
  const rows = text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2 && /^[\w.:-]+$/.test(parts[0].trim()))
    .map(([id, name]) => ({ id: id.trim(), name: name.trim() }));
  const groups = new Map<string, { id: string; name: string; level: EffortLevel | null }[]>();
  for (const row of rows) {
    const match = LEVEL_SUFFIX.exec(row.id);
    const base = match ? match[1] : row.id;
    const list = groups.get(base) ?? [];
    list.push({ ...row, level: match ? (match[2] as EffortLevel) : null });
    groups.set(base, list);
  }
  return [...groups].map(([base, list], index) => {
    const leveled = list.filter((row) => row.level !== null);
    if (list.length === 1 || leveled.length < 2) {
      const only = list[0];
      return { value: only.id, displayName: only.name, description: "", isDefault: index === 0, supportedEffortLevels: [], defaultEffort: null };
    }
    const levels = EFFORT_LEVELS.filter((level) => leveled.some((row) => row.level === level));
    return { value: base, displayName: list[0].name.replace(LEVEL_LABEL, ""), description: "", isDefault: index === 0, supportedEffortLevels: levels, defaultEffort: null };
  });
}

export function effortOf(value: string | null | undefined): EffortLevel | null {
  if (!value) return null;
  const flat = value.toLowerCase().replace(/[^a-z]/g, "");
  if (flat === "extrahigh") return "xhigh";
  return (EFFORT_LEVELS as string[]).includes(flat) ? (flat as EffortLevel) : null;
}

function levelOption(options: AcpConfigOption[]) {
  return options.find((o) => o.id === "thought_level") ?? options.find((o) => o.category === "thought_level");
}

export function currentEffort(options: AcpConfigOption[]): EffortLevel | null {
  return effortOf(levelOption(options)?.currentValue);
}

export function effortLevels(options: AcpConfigOption[] | undefined): EffortLevel[] {
  const values = (levelOption(options ?? [])?.options ?? []).map((o) => effortOf(o.value)).filter((level): level is EffortLevel => level !== null);
  return EFFORT_LEVELS.filter((level) => values.includes(level));
}

export function effortOption(options: AcpConfigOption[], effort: EffortLevel): { configId: string; value: string } | null {
  const option = levelOption(options);
  const value = option?.options?.find((o) => effortOf(o.value) === effort)?.value;
  return option?.id && value ? { configId: option.id, value } : null;
}

export function modelChoice(model: string | null, effort: EffortLevel | null, options: AcpConfigOption[]): { model: string | null; effort: EffortLevel | null } {
  const modelValues = optionValues(options, "model");
  const levels = effortLevels(options);
  if (model && !modelValues.includes(model)) {
    const match = LEVEL_SUFFIX.exec(model);
    if (match && modelValues.includes(match[1])) return { model: match[1], effort: (effort ?? match[2]) as EffortLevel };
  }
  return { model, effort: effort && (levels.length === 0 || levels.includes(effort)) ? effort : null };
}

export function optionValues(options: AcpConfigOption[], category: string): string[] {
  const option = options.find((o) => o.id === category || o.category === category);
  return (option?.options ?? []).map((o) => o.value ?? "").filter(Boolean);
}

export function currentValue(options: AcpConfigOption[], category: string): string | null {
  const option = options.find((o) => o.id === category || o.category === category);
  return option?.currentValue ?? null;
}

export function isAuthText(text: string) {
  return /not logged in|not signed in|sign in|log in|login required|unauthenticated|unauthorized|authentication|401|oauth/i.test(text);
}
