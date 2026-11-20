import type { RpcMethods } from "../shared/protocol";


export type SearchViewOptions = {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  context: number;
  include: string;
  exclude: string;
  // files to include, files to exclude 줄을 펼쳤는지
  details: boolean;
  // Search only in Open Editors
  openOnly: boolean;
  // Use Exclude Settings and Ignore Files
  ignore: boolean;
  // SEARCHPARITY: 바꾸기 줄을 펼쳤는지, 바꿀 글, Preserve Case, 결과 보기(null 이면 설정 search.defaultViewMode 를 따른다)
  showReplace: boolean;
  replaceText: string;
  preserveCase: boolean;
  viewMode: "tree" | "list" | null;
  // Search only in Changed Files (Source Control). Open Editors 와 둘 중 하나만 켠다.
  changedOnly: boolean;
};

export const DEFAULT_CONTEXT = 1;

export const DEFAULT_SEARCH_VIEW: SearchViewOptions = { query: "", matchCase: false, wholeWord: false, regex: false, context: DEFAULT_CONTEXT, include: "", exclude: "", details: false, openOnly: false, ignore: true, showReplace: false, replaceText: "", preserveCase: false, viewMode: null, changedOnly: false };

type Result = RpcMethods["files.search"]["result"];
export type SearchToggles = Pick<SearchViewOptions, "matchCase" | "wholeWord" | "regex">;

// 마지막 검색의 상태. 결과는 저장본에 싣지 않아 다시 켜면 idle 이고, 검색어가 있으면 Run Search 링크가 뜬다.
export type SearchRun = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string } | { kind: "done"; result: Result; query: string; toggles: SearchToggles; workspaceId: string };

export const IDLE_RUN: SearchRun = { kind: "idle" };

export const togglesOf = (options: SearchToggles): SearchToggles => ({ matchCase: options.matchCase, wholeWord: options.wholeWord, regex: options.regex });

// 저장본에서 읽은 값을 쓸 만한 형태로 거른다. 모르는 필드와 틀린 타입은 기본값으로 떨어진다.
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
  // 키보드 포커스가 코드 에디터(.cm-editor) 안에 있는지, Search 뷰 안에 있는지
  inEditor: boolean;
  inSearchView: boolean;
  // 포커스가 있는 에디터의 선택 글
  selection: string | null;
  // Find in Folder 같은 호출이 정한 files to include
  include?: string;
  // 지금 검색어(바꾸지 않을 때의 값)
  query: string;
};

export type FindInFilesPlan = {
  // 검색어를 이 글로 바꾼다(null 이면 그대로)
  seed: string | null;
  // files to include 를 이 값으로 바꾸고 상세 줄을 펼친다(null 이면 그대로)
  include: string | null;
  // 바꾼 뒤 바로 검색한다
  run: boolean;
};

// ⇧⌘F 와 Find in Folder 가 뷰를 열 때 무엇을 바꾸고 검색할지.
// 선택 글은 에디터에 포커스가 있을 때만 쓴다: Search 뷰 입력에 포커스가 있을 때 ⇧⌘F 를 또 눌러도 직전에 친 검색어가 에디터 선택으로 덮이면 안 된다.
export function planFindInFiles(input: FindInFilesInput): FindInFilesPlan {
  const seed = input.inEditor && !input.inSearchView ? seedQuery(input.selection) : null;
  const include = input.include ?? null;
  const query = seed ?? input.query;
  return { seed, include, run: (seed !== null || include !== null) && query.trim() !== "" };
}

// 결과가 다른 폴더의 것이면 그 결과는 지금 폴더의 것이 아니다. 화면은 결과 대신 Run Search 링크를 보인다.
export function runIsCurrent(run: SearchRun, workspaceId: string | null): run is Extract<SearchRun, { kind: "done" }> {
  return run.kind === "done" && run.workspaceId === workspaceId;
}

// 검색어는 있는데 지금 폴더의 결과가 없고 검색 중도 아니면 다시 돌리라는 링크를 띄운다.
export function needsRunLink(options: Pick<SearchViewOptions, "query">, run: SearchRun, workspaceId: string | null): boolean {
  if (options.query.trim() === "" || workspaceId === null) return false;
  if (run.kind === "busy" || run.kind === "error") return false;
  return !runIsCurrent(run, workspaceId);
}

export type FilesSearchRequest = RpcMethods["files.search"]["params"];

// 검색 요청을 만든다. Open Editors 만 찾는데 열린 파일이 없으면 요청 없이 빈 결과(null)다.
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

// search.smartCase: 검색어에 대문자가 없으면 대소문자를 가리지 않고, 있으면 가린다. Match Case 토글을 켜 둔 경우는 늘 가린다.
export const effectiveMatchCase = (options: Pick<SearchViewOptions, "query" | "matchCase">, smartCase: boolean) => options.matchCase || (smartCase && /[A-Z]/.test(options.query));

export const EMPTY_RESULT: Result = { files: [], matches: 0, truncated: false, engine: "git" };

// --- 입력하는 동안 검색 (search.searchOnType) ---

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

// 입력할 때 검색을 시작하기까지 기다릴 시간(ms). 정규식이 틀렸으면 null(검색하지 않는다).
// 정규식이 샘플 글자의 50개 미만에 일치하면 그대로, 100개 미만이면 5배, 그 이상이면 10배다.
export function typingDelay(options: Pick<SearchViewOptions, "query" | "regex">, base: number): number | null {
  if (!options.regex) return base;
  try {
    const matches = REGEX_SAMPLE.match(new RegExp(options.query, "ug"))?.length ?? 0;
    return base * (matches < 50 ? 1 : matches < 100 ? 5 : 10);
  } catch {
    return null;
  }
}
