import type { Agent, BoardCard, BoardColumn, InboxItem, Workspace } from "../shared/protocol";
import { PR_QUERIES, type PrListResult, type PrSummary } from "../shared/prTypes";
import { activeBindings } from "./keymap";
import { keycapsOf } from "./commands";
import { rankFiles } from "./fileSearch";
import { withoutImprovementSessions } from "./improvementRows";
import { relativeTime } from "./sessionList";
import { folderName, sessionOptions } from "./sessionSearch";
import { G } from "./searchStrings";

export type SearchScope = "all" | "sessions" | "files" | "workspaces" | "prs" | "board" | "mentions";
export type SearchKind = "session" | "file" | "workspace" | "pr" | "card" | "mention" | "action";

export const SEARCH_TABS: readonly SearchScope[] = ["all", "sessions", "files", "workspaces", "prs", "board", "mentions"];

const KIND_OF_TAB: Record<Exclude<SearchScope, "all">, SearchKind> = { sessions: "session", files: "file", workspaces: "workspace", prs: "pr", board: "card", mentions: "mention" };
const KIND_ORDER: readonly SearchKind[] = ["session", "file", "workspace", "pr", "card", "mention", "action"];

export const ALL_GROUP_CAP = 5;
export const TAB_LIMIT = 100;
export const RECENT_LIMIT = 8;
export const STAMP_LIMIT = 80;

type RowBase = { key: string; title: string; muted: string | null; aux: string | null };
export type SearchRow = RowBase &
  (
    | { kind: "session"; agent: Agent }
    | { kind: "file"; workspaceId: string; path: string }
    | { kind: "workspace"; workspace: Workspace }
    | { kind: "pr"; pr: PrSummary }
    | { kind: "card"; card: BoardCard }
    | { kind: "mention"; item: InboxItem }
    | { kind: "action"; command: string; keycaps: string[] }
  );

export type SearchGroup = { id: "recent" | SearchKind; label: string; rows: SearchRow[] };

export type SearchData = {
  agents: Agent[];
  workspaces: Workspace[];
  recentAgentIds: string[];
  fileWorkspaceId: string | null;
  files: string[] | undefined;
  recentFiles: { workspaceId: string; path: string }[];
  prs: PrSummary[];
  cards: BoardCard[];
  columns: BoardColumn[];
  mentions: InboxItem[];
  hiddenActions?: readonly string[];
  stamps: Record<string, number>;
  now: number;
};

export function visibleTabs(data: SearchData): SearchScope[] {
  const tops = data.workspaces.filter(isTop);
  return SEARCH_TABS.filter((tab) => {
    if (tab === "all") return true;
    if (tab === "sessions") return withoutImprovementSessions(data.agents).length > 0;
    if (tab === "files") return !!data.fileWorkspaceId && (data.files === undefined || data.files.length > 0);
    if (tab === "workspaces") return tops.length > 0;
    if (tab === "prs") return data.prs.length > 0;
    if (tab === "board") return data.cards.length > 0;
    return data.mentions.length > 0;
  });
}

export type TabKeyEvent = { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing?: boolean };
export type CaretInput = { value: string; selectionStart: number | null; selectionEnd: number | null };

export function tabKeyStep(event: TabKeyEvent, input: CaretInput, tabs: readonly SearchScope[], current: SearchScope): SearchScope | null {
  if (event.isComposing || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return null;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return null;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  if (start !== end) return null;
  const index = tabs.indexOf(current);
  if (index < 0) return null;
  if (event.key === "ArrowLeft") return start === 0 ? (tabs[index - 1] ?? null) : null;
  return start === input.value.length ? (tabs[index + 1] ?? null) : null;
}

const SLUGS: Record<SearchScope, readonly string[]> = {
  all: ["all"],
  sessions: ["sessions", "session"],
  files: ["files", "file"],
  workspaces: ["workspaces", "workspace", "folders", "projects"],
  prs: ["pr", "prs", "pulls", "pullrequests"],
  board: ["board", "cards"],
  mentions: ["mentions", "mention", "slack"],
};

export const slugOf = (tab: SearchScope) => SLUGS[tab][0];

export type Slash = { kind: "suggest"; tabs: SearchScope[] } | { kind: "scope"; tab: SearchScope; rest: string };

export function parseSlash(query: string, available: readonly SearchScope[]): Slash | null {
  const match = /^\/(\S*)(?:\s([\s\S]*))?$/.exec(query);
  if (!match) return null;
  const word = match[1].toLowerCase();
  if (match[2] !== undefined) {
    const tab = available.find((t) => SLUGS[t].includes(word));
    return tab ? { kind: "scope", tab, rest: match[2] } : null;
  }
  return { kind: "suggest", tabs: available.filter((t) => SLUGS[t].some((slug) => slug.startsWith(word))) };
}

export function searchGroups(data: SearchData, tab: SearchScope, query: string): SearchGroup[] {
  const q = query.trim();
  if (tab === "all") {
    if (!q) return compact([group("recent", recentRows(data)), group("action", actionRows("", data))]);
    return compact(KIND_ORDER.map((kind) => group(kind, rowsOf(data, kind, q, ALL_GROUP_CAP))));
  }
  const kind = KIND_OF_TAB[tab];
  const single = group(kind === "file" && !q ? "recent" : kind, rowsOf(data, kind, q, TAB_LIMIT));
  return compact([single]);
}

export const flatRows = (groups: SearchGroup[]) => groups.flatMap((g) => g.rows);

function group(id: SearchGroup["id"], rows: SearchRow[]): SearchGroup {
  return { id, label: G.groups[id], rows };
}

const compact = (groups: SearchGroup[]) => groups.filter((g) => g.rows.length > 0);

function rowsOf(data: SearchData, kind: SearchKind, query: string, limit: number): SearchRow[] {
  if (kind === "session") return sessionRows(data, query).slice(0, limit);
  if (kind === "file") return fileRows(data, query, limit);
  if (kind === "workspace") return workspaceRows(data, query).slice(0, limit);
  if (kind === "pr") return prRows(data, query).slice(0, limit);
  if (kind === "card") return cardRows(data, query).slice(0, limit);
  if (kind === "mention") return mentionRows(data, query).slice(0, limit);
  return actionRows(query, data).slice(0, limit);
}

const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);
const hasAll = (haystack: string, terms: string[]) => {
  const lower = haystack.toLowerCase();
  return terms.every((t) => lower.includes(t));
};

const isTop = (w: Workspace) => !w.parentId && !w.feedback;

export function topWorkspaceOf(workspaces: Workspace[], workspaceId: string | null): Workspace | undefined {
  const own = workspaces.find((w) => w.id === workspaceId);
  return own?.parentId ? workspaces.find((w) => w.id === own.parentId) : own;
}

function sessionRows(data: SearchData, query: string): SearchRow[] {
  return sessionOptions({ agents: data.agents, workspaces: data.workspaces, recentIds: data.recentAgentIds, query }).map((o) => sessionRow(o.agent, o.folder, data.now));
}

function sessionRow(agent: Agent, folder: string, now: number): SearchRow {
  return { kind: "session", key: `session:${agent.id}`, title: agent.title, muted: folder, aux: relativeTime(agent.updatedAt, now), agent };
}

const splitPath = (path: string) => {
  const slash = path.lastIndexOf("/");
  return { name: path.slice(slash + 1), dir: slash < 0 ? "" : path.slice(0, slash + 1) };
};

const fileRow = (workspaceId: string, path: string, aux: string | null): SearchRow => {
  const { name, dir } = splitPath(path);
  return { kind: "file", key: `file:${workspaceId}:${path}`, title: name, muted: dir || null, aux, workspaceId, path };
};

function fileRows(data: SearchData, query: string, limit: number): SearchRow[] {
  const workspaceId = data.fileWorkspaceId;
  if (!workspaceId || !data.files) return [];
  const paths = query.trim() ? rankFiles(data.files, query, limit) : data.recentFiles.filter((f) => f.workspaceId === workspaceId && data.files?.includes(f.path)).map((f) => f.path);
  return paths.slice(0, limit).map((path) => fileRow(workspaceId, path, null));
}

const homeShort = (dir: string) => dir.replace(/^\/Users\/[^/]+/, "~");

function workspaceRows(data: SearchData, query: string): SearchRow[] {
  const terms = words(query);
  return data.workspaces
    .filter(isTop)
    .filter((w) => hasAll(`${w.name} ${w.dir}`, terms))
    .map((workspace) => {
      const sessions = withoutImprovementSessions(data.agents).filter((a) => topWorkspaceOf(data.workspaces, a.workspaceId)?.id === workspace.id).length;
      return { kind: "workspace" as const, key: `workspace:${workspace.id}`, title: workspace.name, muted: homeShort(workspace.dir), aux: G.sessionsCount(sessions), workspace };
    });
}

const shortRepo = (repo: string) => repo.slice(repo.indexOf("/") + 1);

function prRow(pr: PrSummary): SearchRow {
  return { kind: "pr", key: `pr:${pr.repo}#${pr.number}`, title: pr.title, muted: shortRepo(pr.repo), aux: `#${pr.number}`, pr };
}

function prRows(data: SearchData, query: string): SearchRow[] {
  const terms = words(query);
  return data.prs.filter((pr) => hasAll(`${pr.title} ${pr.repo} #${pr.number} ${pr.author?.login ?? ""} ${pr.headRef}`, terms)).map(prRow);
}

function cardRow(card: BoardCard, columns: BoardColumn[]): SearchRow {
  return { kind: "card", key: `card:${card.id}`, title: card.title, muted: columns.find((c) => c.id === card.columnId)?.name ?? null, aux: null, card };
}

function cardRows(data: SearchData, query: string): SearchRow[] {
  const terms = words(query);
  return data.cards.filter((card) => hasAll(`${card.title} ${card.labels.join(" ")} ${data.columns.find((c) => c.id === card.columnId)?.name ?? ""}`, terms)).map((card) => cardRow(card, data.columns));
}

export function plainSlack(text: string): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_all, _id: string, name: string | undefined) => `@${name ?? "user"}`)
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function mentionRow(item: InboxItem, now: number): SearchRow {
  const title = (item.judgment && !item.judgment.skipped ? item.judgment.title : "") || plainSlack(item.text);
  return { kind: "mention", key: `mention:${item.id}`, title: title.slice(0, 120), muted: `${item.from.name} ${item.channelName}`, aux: relativeTime(item.time, now), item };
}

function mentionRows(data: SearchData, query: string): SearchRow[] {
  const terms = words(query);
  return data.mentions.filter((item) => hasAll(`${plainSlack(item.text)} ${item.judgment?.title ?? ""} ${item.from.name} ${item.channelName}`, terms)).map((item) => mentionRow(item, data.now));
}

type SearchAction = { id: string; title: string; command: string; keyCommand: string | null; keywords: string };

export const SEARCH_ACTIONS: readonly SearchAction[] = [
  { id: "newSession", title: G.actions.newSession, command: "newSession", keyCommand: "newSession", keywords: "create start" },
  { id: "quickChat", title: G.actions.quickChat, command: "quickChat", keyCommand: "quickChat", keywords: "create chat" },
  { id: "split", title: G.actions.split, command: "split", keyCommand: "split", keywords: "new pane split right" },
  { id: "board", title: G.actions.board, command: "openBoard", keyCommand: "board", keywords: "kanban cards" },
  { id: "mentions", title: G.actions.mentions, command: "openMentions", keyCommand: "inbox", keywords: "slack inbox" },
  { id: "notes", title: G.actions.notes, command: "openNotes", keyCommand: "notes", keywords: "memo notepad write" },
  { id: "newNote", title: G.actions.newNote, command: "newNote", keyCommand: null, keywords: "memo notepad write create" },
  { id: "improvements", title: G.actions.improvements, command: "openImprovements", keyCommand: null, keywords: "feedback lodestar changes" },
  { id: "settings", title: G.actions.settings, command: "settings", keyCommand: null, keywords: "preferences status" },
  { id: "commandPalette", title: G.actions.commandPalette, command: "commandPalette", keyCommand: "commandPalette", keywords: "commands palette" },
  { id: "quickOpen", title: G.actions.quickOpen, command: "quickOpen", keyCommand: "quickOpen", keywords: "file open" },
];

export const DEFAULT_ACTIONS: readonly string[] = ["newSession", "quickChat", "board", "mentions", "settings"];

const keycapsFor = (command: string | null) => {
  const binding = command ? activeBindings().find((b) => b.command === command) : undefined;
  return binding ? keycapsOf(binding) : [];
};

function actionRows(query: string, data: Pick<SearchData, "hiddenActions">): SearchRow[] {
  const terms = words(query);
  const shown = SEARCH_ACTIONS.filter((a) => !data.hiddenActions?.includes(a.id));
  const list = terms.length ? shown.filter((a) => hasAll(`${a.title} ${a.keywords}`, terms)) : shown.filter((a) => DEFAULT_ACTIONS.includes(a.id));
  return list.map((a) => ({ kind: "action" as const, key: `action:${a.id}`, title: a.title, muted: null, aux: null, command: a.command, keycaps: keycapsFor(a.keyCommand) }));
}

export function recentRows(data: SearchData, limit = RECENT_LIMIT): SearchRow[] {
  const candidates: { row: SearchRow; at: number }[] = [];
  for (const id of data.recentAgentIds) {
    const agent = data.agents.find((a) => a.id === id);
    if (!agent || agent.feedbackId) continue;
    const row = sessionRow(agent, folderName(agent, data.workspaces), data.now);
    candidates.push({ row, at: data.stamps[row.key] ?? (Date.parse(agent.updatedAt) || 0) });
  }
  const topCount = data.workspaces.filter(isTop).length;
  data.recentFiles.forEach((file, index) => {
    const workspace = topWorkspaceOf(data.workspaces, file.workspaceId);
    if (!workspace) return;
    const row = fileRow(file.workspaceId, file.path, topCount > 1 ? workspace.name : null);
    candidates.push({ row, at: data.stamps[row.key] ?? -index });
  });
  const stamped = (row: SearchRow) => {
    const at = data.stamps[row.key];
    if (at !== undefined) candidates.push({ row, at });
  };
  data.prs.map(prRow).forEach(stamped);
  data.cards.map((c) => cardRow(c, data.columns)).forEach(stamped);
  data.mentions.map((m) => mentionRow(m, data.now)).forEach(stamped);
  return candidates
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((c) => c.row);
}

export function noteStamp(stamps: Record<string, number>, key: string, at: number): Record<string, number> {
  const next = { ...stamps, [key]: at };
  const keys = Object.keys(next);
  if (keys.length <= STAMP_LIMIT) return next;
  const drop = keys.sort((a, b) => next[a] - next[b]).slice(0, keys.length - STAMP_LIMIT);
  for (const key of drop) delete next[key];
  return next;
}

export function altLabel(row: SearchRow): string | null {
  if (row.kind === "session") return G.alt.session;
  if (row.kind === "file") return G.alt.file;
  if (row.kind === "workspace") return G.alt.workspace;
  if (row.kind === "pr") return G.alt.pr;
  if (row.kind === "card") return row.card.workspaceId ? G.alt.card : null;
  if (row.kind === "mention") return G.alt.mention;
  return null;
}

export function uniquePrs(lists: Record<string, { data: PrListResult | null }>): PrSummary[] {
  const seen = new Map<string, PrSummary>();
  for (const list of Object.values(lists)) {
    for (const query of PR_QUERIES) {
      for (const pr of list.data?.[query] ?? []) {
        const key = `${pr.repo}#${pr.number}`;
        if (!seen.has(key)) seen.set(key, pr);
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function mentionItems(items: InboxItem[] | undefined): InboxItem[] {
  return (items ?? []).filter((i) => !i.archived).sort((a, b) => b.time.localeCompare(a.time));
}
