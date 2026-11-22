export type SearchSettings = {
  searchOnType: boolean;
  searchOnTypeDebouncePeriod: number;
  showLineNumbers: boolean;
  collapseResults: "auto" | "alwaysCollapse" | "alwaysExpand";
  defaultViewMode: "tree" | "list";
  sortOrder: "default" | "fileNames" | "type" | "modified" | "countDescending" | "countAscending";
  actionsPosition: "auto" | "right";
  useReplacePreview: boolean;
  smartCase: boolean;
  seedOnFocus: boolean;
  seedWithNearestWord: boolean;
  maxResults: number | null;
  useIgnoreFiles: boolean;
  exclude: string[];
};

export const DEFAULT_SEARCH_EXCLUDE: Record<string, boolean> = { "**/node_modules": true, "**/bower_components": true, "**/*.code-search": true };
export const DEFAULT_FILES_EXCLUDE: Record<string, boolean> = { "**/.git": true, "**/.svn": true, "**/.hg": true, "**/.DS_Store": true, "**/Thumbs.db": true };

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  searchOnType: true,
  searchOnTypeDebouncePeriod: 300,
  showLineNumbers: false,
  collapseResults: "alwaysExpand",
  defaultViewMode: "tree",
  sortOrder: "default",
  actionsPosition: "right",
  useReplacePreview: true,
  smartCase: false,
  seedOnFocus: false,
  seedWithNearestWord: false,
  maxResults: 20_000,
  useIgnoreFiles: true,
  exclude: enabledGlobs(DEFAULT_SEARCH_EXCLUDE, DEFAULT_FILES_EXCLUDE),
};

function enabledGlobs(...maps: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const map of maps) for (const [glob, on] of Object.entries(map)) if (on === true && !out.includes(glob)) out.push(glob);
  return out;
}

const pickEnum = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback);
const pickBool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const asMap = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

export function parseVscodeSearchSettings(settings: Record<string, unknown>): SearchSettings {
  const d = DEFAULT_SEARCH_SETTINGS;
  const debounce = settings["search.searchOnTypeDebouncePeriod"];
  const max = settings["search.maxResults"];
  return {
    searchOnType: pickBool(settings["search.searchOnType"], d.searchOnType),
    searchOnTypeDebouncePeriod: typeof debounce === "number" && debounce >= 0 ? debounce : d.searchOnTypeDebouncePeriod,
    showLineNumbers: pickBool(settings["search.showLineNumbers"], d.showLineNumbers),
    collapseResults: pickEnum(settings["search.collapseResults"], ["auto", "alwaysCollapse", "alwaysExpand"], d.collapseResults),
    defaultViewMode: pickEnum(settings["search.defaultViewMode"], ["tree", "list"], d.defaultViewMode),
    sortOrder: pickEnum(settings["search.sortOrder"], ["default", "fileNames", "type", "modified", "countDescending", "countAscending"], d.sortOrder),
    actionsPosition: pickEnum(settings["search.actionsPosition"], ["auto", "right"], d.actionsPosition),
    useReplacePreview: pickBool(settings["search.useReplacePreview"], d.useReplacePreview),
    smartCase: pickBool(settings["search.smartCase"], d.smartCase),
    seedOnFocus: pickBool(settings["search.seedOnFocus"], d.seedOnFocus),
    seedWithNearestWord: pickBool(settings["search.seedWithNearestWord"], d.seedWithNearestWord),
    maxResults: max === null ? null : typeof max === "number" && max > 0 ? max : d.maxResults,
    useIgnoreFiles: pickBool(settings["search.useIgnoreFiles"], d.useIgnoreFiles),
    exclude: enabledGlobs({ ...DEFAULT_SEARCH_EXCLUDE, ...(asMap(settings["search.exclude"]) ?? {}) }, { ...DEFAULT_FILES_EXCLUDE, ...(asMap(settings["files.exclude"]) ?? {}) }),
  };
}
