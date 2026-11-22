import { MergeView } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import { DIFF_CONFIG } from "./diffMarks";
import { diffCodeExtensions } from "./diffSplit";
import { FileTypeIcon } from "./FileTypeIcon";
import { useReveal } from "./replacePreview";
import { rpc } from "./rpc";
import { currentModel, useSearchUi } from "./searchState";
import { previewTextOf, replacementOf } from "./searchReplaceModel";
import { useStore, type ReplacePreviewTab } from "./store";

export function ReplacePreviewView({ tab, active }: { tab: ReplacePreviewTab; active: boolean }) {
  const [original, setOriginal] = useState<string | null>(null);
  const searchView = useStore((s) => s.searchView);
  const run = useStore((s) => s.searchRun);
  const dismissed = useSearchUi((s) => s.dismissed);
  const settings = useSearchUi((s) => s.settings);
  useEffect(() => {
    let live = true;
    void rpc.call("files.read", { workspaceId: tab.workspaceId, path: tab.path }).then((file) => live && setOriginal(file.text));
    return () => {
      live = false;
    };
  }, [tab.workspaceId, tab.path]);

  const modified = useMemo(() => {
    if (original === null) return null;
    const hits = currentModel().files.find((file) => file.path === tab.path)?.hits ?? [];
    return previewTextOf(original, hits, (hit) => replacementOf(hit, searchView, settings.smartCase));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, run, dismissed, searchView, settings.smartCase, tab.path]);

  return (
    <div className="editor replace-preview" style={{ display: active ? "flex" : "none" }} data-testid="replace-preview">
      <div className="pane-header">
        <FileTypeIcon name={tab.path} />
        <span className="editor-path" title={tab.path}>
          {tab.path}
        </span>
      </div>
      {original !== null && modified !== null ? <PreviewMerge tab={tab} original={original} modified={modified} /> : <div className="empty-hint" />}
    </div>
  );
}

function PreviewMerge({ tab, original, modified }: { tab: ReplacePreviewTab; original: string; modified: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const reveal = useReveal(tab.key);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const merge = new MergeView({
      parent: host,
      a: { doc: original, extensions: diffCodeExtensions(tab.path) },
      b: { doc: modified, extensions: diffCodeExtensions(tab.path) },
      diffConfig: DIFF_CONFIG,
      highlightChanges: true,
      gutter: true,
    });
    mergeRef.current = merge;
    return () => {
      merge.destroy();
      mergeRef.current = null;
    };
  }, [original, modified, tab.path]);

  useEffect(() => {
    const merge = mergeRef.current;
    if (!merge || !reveal) return;
    const doc = merge.b.state.doc;
    const line = doc.line(Math.min(Math.max(reveal.line, 1), doc.lines));
    merge.b.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
  }, [reveal, original, modified]);

  return <div className="editor-host file-diff-host replace-preview-host" data-readonly="" ref={hostRef} />;
}
