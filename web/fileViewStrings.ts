// Q2: 이미지와 바이너리 미리보기, 읽기 전용과 삭제된 파일 표시, 저장 충돌 배너, 대화 안 찾기 문구. 영어 UI 문구만 둔다.
export const FV = {
  previewAria: "File preview",
  previewTitle: "Image preview",
  zoomIn: "Zoom In",
  zoomOut: "Zoom Out",
  actualSize: "Actual Size (100%)",
  fitToView: "Fit to View",
  reveal: "Reveal in Finder",
  imageLoadFailed: "This image could not be displayed.",
  imageTooLarge: (size: string) => `This image is too large to preview (${size}).`,
  imageDimensions: (width: number, height: number) => `${width} × ${height}`,
  binaryTitle: "Binary file",
  binaryDetail: (size: string) => `The file is not text (${size}), so it cannot be shown or edited here.`,
  zoomLabel: (percent: number) => `${percent}%`,

  // 저장 충돌 배너: 본문은 짧게, 전체 문구는 툴팁에
  conflictShort: "File changed on disk",
  conflictSaveShort: "File changed on disk",
  compareTip: "Compare your version with the file on disk",
  overwriteTip: "Overwrite the file on disk with your changes",

  // 종료 때 저장 안 한 내용을 보관하는 hot exit(web/windowState.ts)
  hotExitTooLarge: (name: string) => `Unsaved changes in ${name} were too large to keep when the app closed.`,

  // 읽기 전용
  readOnlyMessage: "This file is read-only. Save As… or change permissions.",
  readOnlyBanner: "Read-only file. Save As… or change permissions to edit it.",
  saveAs: "Save As…",
  saveAsTitle: "Save As",
  saveAsConfirm: "Save",
  readOnlyTab: "Read-only",

  // 지워진 파일
  deletedSuffix: "(Deleted)",
  deletedTip: "This file was deleted on disk. Saving creates it again.",
  deletedBanner: "This file was deleted on disk. Saving creates it again.",
} as const;

export const CF = {
  find: "Find",
  caseSensitive: "Match Case (⌥⌘C)",
  wholeWord: "Match Whole Word (⌥⌘W)",
  regexp: "Use Regular Expression (⌥⌘R)",
  previous: "Previous Match (⇧Enter)",
  next: "Next Match (Enter)",
  close: "Close (Escape)",
  aria: "Find in chat",
  noResults: "No results",
  count: (index: number, total: number, capped: boolean) => `${index} of ${total}${capped ? "+" : ""}`,
} as const;
