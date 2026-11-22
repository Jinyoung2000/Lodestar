import type { RpcMethods } from "../shared/protocol";


export type SearchViewOptions = {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  context: number;
  include: string;
  exclude: string;
  details: boolean;
  openOnly: boolean;
  ignore: boolean;
  showReplace: boolean;
  replaceText: string;
  preserveCase: boolean;
  viewMode: "tree" | "list" | null;
  changedOnly: boolean;
};

export const DEFAULT_CONTEXT = 1;

export const DEFAULT_SEARCH_VIEW: SearchViewOptions = { query: "", matchCase: false, wholeWord: false, regex: false, context: DEFAULT_CONTEXT, include: "", exclude: "", details: false, openOnly: false, ignore: true, showReplace: false, replaceText: "", preserveCase: false, viewMode: null, changedOnly: false };

type Result = RpcMethods["files.search"]["result"];
export type SearchToggles = Pick<SearchViewOptions, "matchCase" | "wholeWord" | "regex">;

export type SearchRun = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string } | { kind: "done"; result: Result; query: string; toggles: SearchToggles; workspaceId: string; roots?: { label: string; workspaceId: string }[] };

export const IDLE_RUN: SearchRun = { kind: "idle" };

export const togglesOf = (options: SearchToggles): SearchToggles => ({ matchCase: options.matchCase, wholeWord: options.wholeWord, regex: options.regex });

export function sanitizeSearchView(raw: unknown): SearchViewOptions {
  if (!raw || typeof raw !== "object") return DEFAULT_SEARCH_VIEW;
  const value = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const context = typeof value.context === "number" && Number.isFinite(value.context) ? Math.max(0, Math.min(5, Math.round(value.context))) : DEFAULT_CONTEXT;
  return {
    query: text(value.query),
    matchCase: flag(value.matchCase, false),
    wholeWord: flag(value.wholeWord, false),
    regex: flag(value.regex, false),
    context,
    include: text(value.include),
    exclude: text(value.exclude),
    details: flag(value.details, false),
    openOnly: flag(value.openOnly, false),
    ignore: flag(value.ignore, true),
    showReplace: flag(value.showReplace, false),
    replaceText: text(value.replaceText),
    preserveCase: flag(value.preserveCase, false),
    viewMode: value.viewMode === "tree" || value.viewMode === "list" ? value.viewMode : null,
    changedOnly: flag(value.changedOnly, false),
  };
}

export function seedQuery(selection: string | null | undefined): string | null {
  if (!selection) return null;
  if (/[\r\n]/.test(selection)) return null;
  return selection.trim() === "" ? null : selection;
}

export type FindInFilesInput = {
  inEditor: boolean;
  inSearchView: boolean;
  selection: string | null;
  include?: string;
  query: string;
};

export type FindInFilesPlan = {
  seed: string | null;
  include: string | null;
  run: boolean;
};

export function planFindInFiles(input: FindInFilesInput): FindInFilesPlan {
  const seed = input.inEditor && !input.inSearchView ? seedQuery(input.selection) : null;
  const include = input.include ?? null;
  const query = seed ?? input.query;
  return { seed, include, run: (seed !== null || include !== null) && query.trim() !== "" };
}

export function runIsCurrent(run: SearchRun, workspaceId: string | null): run is Extract<SearchRun, { kind: "done" }> {
  return run.kind === "done" && run.workspaceId === workspaceId;
}

export function needsRunLink(options: Pick<SearchViewOptions, "query">, run: SearchRun, workspaceId: string | null): boolean {
  if (options.query.trim() === "" || workspaceId === null) return false;
  if (run.kind === "busy" || run.kind === "error") return false;
  return !runIsCurrent(run, workspaceId);
}

export type FilesSearchRequest = RpcMethods["files.search"]["params"];

export function buildSearchRequest(workspaceId: string, options: SearchViewOptions, openPaths: readonly string[], detail: { ranges?: boolean; smartCase?: boolean; changedPaths?: readonly string[] } = {}): FilesSearchRequest | null {
  if (options.openOnly && openPaths.length === 0) return null;
  if (options.changedOnly && !options.openOnly && (detail.changedPaths ?? []).length === 0) return null;
  return {
    ...(detail.ranges ? { ranges: true } : {}),
    workspaceId,
    query: options.query,
    matchCase: effectiveMatchCase(options, detail.smartCase === true),
    wholeWord: options.wholeWord,
    regex: options.regex,
    context: detail.ranges ? 0 : options.context,
    include: options.openOnly ? openPaths.join(",") : options.changedOnly ? (detail.changedPaths ?? []).join(",") : options.include,
    exclude: options.exclude,
    ignore: options.ignore,
  };
}

export const effectiveMatchCase = (options: Pick<SearchViewOptions, "query" | "matchCase">, smartCase: boolean) => options.matchCase || (smartCase && /[A-Z]/.test(options.query));

export const EMPTY_RESULT: Result = { files: [], matches: 0, truncated: false, engine: "git" };

const REGEX_SAMPLE = "~!@#$%^&*()_+`1234567890-=qwertyuiop[]\\QWERTYUIOP{}|asdfghjkl;'ASDFGHJKL:\"zxcvbnm,./ZXCVBNM<>? ";

export function regexError(query: string, regex: boolean): string | null {
  if (!regex || query === "") return null;
  try {
    new RegExp(query, "u");
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export function typingDelay(options: Pick<SearchViewOptions, "query" | "regex">, base: number): number | null {
  if (!options.regex) return base;
  try {
    const matches = REGEX_SAMPLE.match(new RegExp(options.query, "ug"))?.length ?? 0;
    return base * (matches < 50 ? 1 : matches < 100 ? 5 : 10);
  } catch {
    return null;
  }
}
