import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { EditPreview } from "./approvalPreview";
import { DIFF_CONFIG } from "./diffMarks";
import { COLLAPSE_UNCHANGED, diffCodeExtensions } from "./diffSplit";

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
