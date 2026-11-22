export const SV = {
  title: "Search",
  placeholderSearch: "Search",
  placeholderReplace: "Replace",
  ariaSearch: "Search: Type Search Term and press Enter to search",
  ariaReplace: "Replace: Type replace term and press Enter to preview",
  historyHint: " or ⇅ for history",
  historyHintParen: " (⇅ for history)",
  toggleReplace: "Toggle Replace",
  replaceAll: "Replace All",
  replaceAllDisabled: "Replace All (Submit Search to Enable)",
  matchCase: "Match Case",
  matchWholeWord: "Match Whole Word",
  useRegex: "Use Regular Expression",
  preserveCase: "Preserve Case",
  toggleDetails: "Toggle Search Details",
  filesToInclude: "files to include",
  filesToExclude: "files to exclude",
  placeholderInclude: "e.g. *.ts, src/**/include",
  onlyChangedFiles: "Search only in Changed Files (Source Control)",
  onlyOpenEditors: "Search only in Open Editors",
  useExcludeSettings: "Use Exclude Settings and Ignore Files",
  actionsAria: "Search actions",
  refresh: "Refresh",
  cancelSearch: "Cancel Search",
  clearResults: "Clear Search Results",
  openNewEditor: "Open New Search Editor",
  viewAsTree: "View as Tree",
  viewAsList: "View as List",
  collapseAll: "Collapse All",
  expandAll: "Expand All",
  openInEditor: "Open in editor",
  openInEditorTip: "Copy current search results to an editor",
  exclusionsDisabled: "exclude settings and ignore files are disabled",
  enable: "enable",
  searchingOnlyOpen: "searching only in open files",
  disable: "disable",
  searchInAllFiles: "Search in entire workspace",
  searchAgainInAllFiles: "Search again in all files",
  searchAgain: "Search again",
  openSettings: "Open Settings",
  canceled: "Search was canceled before any results could be found - ",
  limitHit: "The result set only contains a subset of all matches. Be more specific in your search to narrow down the results.",
  replaceAllTitle: "Replace All",
  replaceButton: "Replace",
  replace: "Replace",
  dismiss: "Dismiss",
  restrictToFolder: "Restrict Search to Folder",
  expandRecursively: "Expand Recursively",
  excludeFolder: "Exclude Folder from Search",
  excludeFileType: "Exclude File Type from Search",
  includeFileType: "Include File Type from Search",
  copy: "Copy",
  copyPath: "Copy Path",
  copyAll: "Copy All",
  revealInExplorer: "Reveal in Explorer View",
  replacePreviewTitle: (a: string, b: string) => `${a} ↔ ${b} (Replace Preview)`,
  matchBadge: (n: number) => (n === 1 ? `${n} match found` : `${n} matches found`),
  fileBadge: (n: number) => (n === 1 ? `${n} file found` : `${n} files found`),
  withKey: (label: string, key: string) => (key ? `${label} (${key})` : label),
  skippedUnsaved: (files: number) => `${files} ${files === 1 ? "file has" : "files have"} unsaved changes and ${files === 1 ? "was" : "were"} not replaced.`,
  conflict: "Some files changed after the search and were not replaced. Run the search again.",
} as const;

export function resultCount(matches: number, files: number): string {
  return `${matches} ${matches === 1 ? "result" : "results"} in ${files} ${files === 1 ? "file" : "files"}`;
}

export function confirmReplaceAll(matches: number, files: number, replaceText: string): string {
  const lines = replaceText.split("\n");
  const shown = lines.length > 10 ? `${lines.slice(0, 10).join("\n")}\n...` : replaceText;
  const head = `Replace ${matches} ${matches === 1 ? "occurrence" : "occurrences"} across ${files} ${files === 1 ? "file" : "files"}`;
  return replaceText ? `${head} with '${shown}'?` : `${head}?`;
}

export function replacedAll(matches: number, files: number, replaceText: string): string {
  const head = `Replaced ${matches} ${matches === 1 ? "occurrence" : "occurrences"} across ${files} ${files === 1 ? "file" : "files"}`;
  return replaceText ? `${head} with '${replaceText}'.` : `${head}.`;
}

export type EmptyKind = "all" | "openEditors";

export function noResults(kind: EmptyKind, include: string, exclude: string): string {
  if (kind === "openEditors") {
    if (include && exclude) return `No results found in open editors matching '${include}' excluding '${exclude}' - `;
    if (include) return `No results found in open editors matching '${include}' - `;
    if (exclude) return `No results found in open editors excluding '${exclude}' - `;
    return "No results found in open editors. Review your configured exclusions and check your gitignore files - ";
  }
  if (include && exclude) return `No results found in '${include}' excluding '${exclude}' - `;
  if (include) return `No results found in '${include}' - `;
  if (exclude) return `No results found excluding '${exclude}' - `;
  return "No results found. Review your configured exclusions and check your gitignore files - ";
}
