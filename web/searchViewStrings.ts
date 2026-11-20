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
  placeholderExclude: "e.g. *.ts, src/**/exclude",
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
  // Replace All 확인 대화상자
  replaceAllTitle: "Replace All",
  replaceButton: "Replace",
  // 컨텍스트 메뉴와 hover 단추
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

// "N results in M files" 의 단수 복수 4가지
export function resultCount(matches: number, files: number): string {
  return `${matches} ${matches === 1 ? "result" : "results"} in ${files} ${files === 1 ? "file" : "files"}`;
}

// Replace All 확인 문구. 바꿀 글은 10줄을 넘으면 앞 10줄 뒤에 "..." 로 줄인다.
export function confirmReplaceAll(matches: number, files: number, replaceText: string): string {
  const lines = replaceText.split("\n");
  const shown = lines.length > 10 ? `${lines.slice(0, 10).join("\n")}\n...` : replaceText;
  const head = `Replace ${matches} ${matches === 1 ? "occurrence" : "occurrences"} across ${files} ${files === 1 ? "file" : "files"}`;
  return replaceText ? `${head} with '${shown}'?` : `${head}?`;
}

// Replace All 이 끝난 뒤 요약 줄 자리에 나오는 문구
export function replacedAll(matches: number, files: number, replaceText: string): string {
  const head = `Replaced ${matches} ${matches === 1 ? "occurrence" : "occurrences"} across ${files} ${files === 1 ? "file" : "files"}`;
  return replaceText ? `${head} with '${replaceText}'.` : `${head}.`;
}

export type EmptyKind = "all" | "openEditors";

// 결과가 없을 때의 문구(끝에 " - " 가 붙고 뒤에 링크 하나가 이어진다). include 와 exclude 가 있으면 링크는 "Search again in all files", 없으면 "Open Settings".
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
