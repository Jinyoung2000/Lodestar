import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ScmFileDiff, ScmHunkInfo } from "../shared/scm";
import { DIFF_CONFIG } from "./diffMarks";
import { bindDiffView, diffLspTarget, initialModifiedText } from "./diffLsp";
import { DiffContextMenu } from "./LspMenu";
import { COLLAPSE_UNCHANGED, diffCodeExtensions } from "./diffSplit";
import { relabelCollapsed } from "./DiffView";
import { subscribeEditorFont } from "./editorFont";
import { FileTypeIcon } from "./FileTypeIcon";
import { Codicon } from "./icons";
import { rpc } from "./rpc";
import { hunkGutter } from "./scmHunkGutter";
import { M } from "./scmStrings";
import { flash, type ScmDiffTab } from "./store";
import { Button } from "./ui/button";
import { reloadWorkspaceChanges } from "./workspaceChanges";
import { onWorkspaceChanged } from "./workspaceEvents";

// Source Control 의 Open Changes 가 여는 diff 탭. 세션과 무관하게 저장소의 인덱스를 기준으로 보이고, hunk 마다 Stage Block 또는 Unstage Block 이 있다.
// staged 는 HEAD 대 인덱스(단추는 Unstage Block), changes 는 인덱스 대 작업 트리(단추는 Stage Block)다.
export function ScmDiffView({ tab, active }: { tab: ScmDiffTab; active: boolean }) {
  const target = { agentId: tab.agentId, workspaceId: tab.workspaceId };
  const { diff, error, reload } = useScmFileDiff(tab);
  const [busy, setBusy] = useState(false);
  const staged = tab.section === "staged";

  // 서버가 다시 읽은 hunk 지문과 함께 한 hunk 를 올리거나 내린다. 파일이 그 사이 바뀌었으면 서버가 거절하고, 어느 쪽이든 diff 를 새로 읽는다.
  const actOnHunk = useCallback(
    async (hunk: ScmHunkInfo) => {
      setBusy(true);
      try {
        await rpc.call("scm.stageHunk", { ...target, rel: tab.rel, section: tab.section, index: hunk.index, hash: hunk.hash });
      } catch (e) {
        flash(M.hunkFailed((e as Error).message), "error");
      } finally {
        setBusy(false);
        await reload();
        void reloadWorkspaceChanges(tab.workspaceId);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.agentId, tab.workspaceId, tab.rel, tab.section, reload],
  );

  const wholeFile = async () => {
    setBusy(true);
    try {
      await rpc.call(staged ? "scm.unstage" : "scm.stage", { ...target, paths: [tab.rel] });
    } catch (e) {
      flash(M.hunkFailed((e as Error).message), "error");
    } finally {
      setBusy(false);
      await reload();
      void reloadWorkspaceChanges(tab.workspaceId);
    }
  };

  const relative = tab.rel;
  return (
    <div className="editor scm-diff" style={{ display: active ? "flex" : "none" }} data-testid="scm-diff">
      <div className="pane-header">
        <FileTypeIcon name={tab.path} />
        <span className="editor-path" title={tab.path}>
          {relative}
        </span>
        <span className="faint xs">{staged ? M.sectionStaged : M.sectionChanges}</span>
        {diff && diff.hunks.length > 0 && <span className="faint xs">{M.blocks(diff.hunks.length)}</span>}
        <span className="spacer" />
        {diff && (diff.hunks.length > 0 || diff.binary || diff.tooLarge) && (
          <Button size="icon" aria-label={staged ? M.unstage : M.stage} title={staged ? M.unstage : M.stage} disabled={busy} onClick={() => void wholeFile()}>
            <Codicon name={staged ? "remove" : "add"} />
          </Button>
        )}
      </div>
      <ScmDiffBody tab={tab} diff={diff} error={error} busy={busy} onHunk={actOnHunk} />
    </div>
  );
}

function ScmDiffBody({ tab, diff, error, busy, onHunk }: { tab: ScmDiffTab; diff: ScmFileDiff | null; error: string | null; busy: boolean; onHunk: (hunk: ScmHunkInfo) => void }) {
  if (error && !diff) return <div className="editor-error">{M.diffLoadFailed(error)}</div>;
  if (!diff) return <div className="empty-hint">{M.loading}</div>;
  if (diff.binary) return <Notice title={M.diffBinary} text={M.diffBinaryText} />;
  if (diff.tooLarge) return <Notice title={M.diffTooLarge} text={M.diffTooLargeText} />;
  if (diff.original === diff.modified || (diff.original === null && diff.modified === null)) return <Notice title={M.diffNoChanges} text={M.diffNoChangesText} />;
  return <HunkEditor tab={tab} diff={diff} busy={busy} onHunk={onHunk} />;
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div className="changes-empty">
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

function HunkEditor({ tab, diff, busy, onHunk }: { tab: ScmDiffTab; diff: ScmFileDiff; busy: boolean; onHunk: (hunk: ScmHunkInfo) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // LSP 가 붙은 보기(오른쪽 클릭 메뉴의 대상). Staged 구간은 붙지 않는다.
  const lspViewRef = useRef<EditorView | null>(null);
  const scrollRef = useRef(0);
  // 단추 동작은 최신 busy 와 콜백을 보게 하되, 편집기를 다시 만들지는 않는다
  const actRef = useRef(onHunk);
  actRef.current = busy ? () => undefined : onHunk;
  const label = tab.section === "staged" ? M.unstageBlock : M.stageBlock;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const lsp = tab.section === "changes" && diff.modified !== null ? diffLspTarget(tab.workspaceId, tab.path, true) : null;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialModifiedText(lsp, diff.modified ?? ""),
        extensions: [
          hunkGutter(diff.hunks, tab.section === "staged" ? "unstage" : "stage", label, (hunk) => actRef.current(hunk)),
          diffCodeExtensions(tab.path, false, undefined, lsp),
          unifiedMergeView({ original: diff.original ?? "", mergeControls: false, collapseUnchanged: COLLAPSE_UNCHANGED, diffConfig: DIFF_CONFIG }),
          EditorView.contentAttributes.of({ "aria-label": tab.rel }),
        ],
      }),
    });
    viewRef.current = view;
    const unbind = lsp ? bindDiffView(lsp, view) : null;
    lspViewRef.current = lsp ? view : null;
    relabelCollapsed(host);
    // 단추를 눌러 diff 를 다시 만들 때 보던 자리를 지킨다
    requestAnimationFrame(() => (view.scrollDOM.scrollTop = scrollRef.current));
    const observer = new MutationObserver(() => relabelCollapsed(host));
    observer.observe(host, { childList: true, subtree: true });
    const onScroll = () => (scrollRef.current = view.scrollDOM.scrollTop);
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      view.scrollDOM.removeEventListener("scroll", onScroll);
      unbind?.();
      view.destroy();
      viewRef.current = null;
      lspViewRef.current = null;
    };
  }, [diff, tab.path, tab.rel, tab.section, label]);

  // 코드 글꼴 설정이 바뀌면 글자 크기와 줄 높이를 다시 잰다.
  useEffect(() => subscribeEditorFont(() => viewRef.current?.requestMeasure()), []);

  return (
    <>
      <div className="editor-host file-diff-host scm-diff-host" data-mode="inline" data-readonly="" ref={hostRef} />
      <DiffContextMenu host={hostRef} lspView={() => lspViewRef.current} workspaceId={tab.workspaceId} />
    </>
  );
}

// 서버에서 파일 diff 를 읽는다. 바깥 변화(workspaceChanged)와 이 탭이 다시 보일 때 새로 읽고, 내용이 같으면 상태를 바꾸지 않아 편집기가 다시 만들어지지 않는다.
function useScmFileDiff(tab: ScmDiffTab) {
  const [state, setState] = useState<{ diff: ScmFileDiff | null; error: string | null }>({ diff: null, error: null });
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      const next = await rpc.call("scm.fileDiff", { agentId: tab.agentId, workspaceId: tab.workspaceId, rel: tab.rel, section: tab.section });
      if (mine !== sequence.current) return;
      setState((prev) => (prev.diff && sameDiff(prev.diff, next) ? { diff: prev.diff, error: null } : { diff: next, error: null }));
    } catch (e) {
      if (mine === sequence.current) setState((prev) => ({ diff: prev.diff, error: (e as Error).message }));
    }
  }, [tab.agentId, tab.workspaceId, tab.rel, tab.section]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => onWorkspaceChanged(tab.workspaceId, () => void reload()), [tab.workspaceId, reload]);
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);
  return { ...state, reload };
}

function sameDiff(a: ScmFileDiff, b: ScmFileDiff) {
  return a.original === b.original && a.modified === b.modified && a.binary === b.binary && a.tooLarge === b.tooLarge && a.hunks.length === b.hunks.length && a.hunks.every((h, i) => h.hash === b.hunks[i].hash);
}
