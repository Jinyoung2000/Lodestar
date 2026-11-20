import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { EditPreview } from "./approvalPreview";
import { DIFF_CONFIG } from "./diffMarks";
import { COLLAPSE_UNCHANGED, diffCodeExtensions } from "./diffSplit";

// 편집 승인 카드 안의 변경 미리보기. 변경 패널 diff 와 같은 확장(색, 구문 강조, 줄 번호, 바뀌지 않은 줄 접기)으로 읽기 전용 unified diff 를 그린다.
// 새 파일은 기준이 빈 문서라 전체가 추가로 보인다.
export function ApprovalDiff({ preview }: { preview: EditPreview }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: preview.after,
        extensions: [diffCodeExtensions(preview.path), unifiedMergeView({ original: preview.before, mergeControls: false, collapseUnchanged: COLLAPSE_UNCHANGED, diffConfig: DIFF_CONFIG })],
      }),
    });
    return () => view.destroy();
  }, [preview.path, preview.before, preview.after]);
  return <div className="approval-diff" ref={hostRef} data-new={preview.isNew || undefined} data-testid="approval-diff" />;
}
