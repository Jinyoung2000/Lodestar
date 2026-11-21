import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ScmFileDiff, ScmHunkInfo } from "../shared/scm";
import { confirmAction } from "./ConfirmDialog";
import { useDefaults } from "./defaults";
import { DIFF_CONFIG } from "./diffMarks";
import { bindDiffView, diffLspTarget, initialModifiedText, type DiffLspTarget } from "./diffLsp";
import { chooseDiffMode, useDiffView } from "./diffMode";
import { registerDiffNav } from "./diffNav";
import { DiffContextMenu } from "./LspMenu";
import { COLLAPSE_UNCHANGED, diffCodeExtensions, stepChunk } from "./diffSplit";
import { trackHover, watchChunkBoxes } from "./diffGutterHover";
import { DiffCrumbs, relabelCollapsed } from "./DiffView";
import { subscribeEditorFont } from "./editorFont";
import { rpc } from "./rpc";
import { chunkLines, hunkActionButton, hunkForLines, hunkGutter, type HunkButton } from "./scmHunkGutter";
import { M } from "./scmStrings";
import { flash, openFile, useStore, type ScmDiffTab } from "./store";
import { reloadWorkspaceChanges } from "./workspaceChanges";
import { onWorkspaceChanged } from "./workspaceEvents";

// Source Control 의 Open Changes 가 여는 diff 탭. 세션과 무관하게 저장소의 인덱스를 기준으로 보이고, hunk 마다 Stage Block 또는 Unstage Block 이 있다.
// staged 는 HEAD 대 인덱스(단추는 Unstage Block), changes 는 인덱스 대 작업 트리(단추는 Stage Block 과 Discard Block)다.
export function ScmDiffView({ tab, active }: { tab: ScmDiffTab; active: boolean }) {
  const target = { agentId: tab.agentId, workspaceId: tab.workspaceId };
  const { diff, error, reload } = useScmFileDiff(tab);
  const [busy, setBusy] = useState(false);
  const staged = tab.section === "staged";
  const handle = useRef<MountedDiff | null>(null);
  const workspaceDir = useStore((s) => s.workspaces.find((w) => w.id === tab.workspaceId)?.dir ?? "");
  const relative = workspaceDir && tab.path.startsWith(`${workspaceDir}/`) ? tab.path.slice(workspaceDir.length + 1) : tab.path;

  const settle = async (job: () => Promise<unknown>, failed: (message: string) => string) => {
    setBusy(true);
    try {
      await job();
    } catch (e) {
      flash(failed((e as Error).message), "error");
    } finally {
      setBusy(false);
      await reload();
      void reloadWorkspaceChanges(tab.workspaceId);
    }
  };
  // 서버가 다시 읽은 hunk 지문과 함께 한 hunk 를 올리거나 내린다. 파일이 그 사이 바뀌었으면 서버가 거절하고, 어느 쪽이든 diff 를 새로 읽는다.
  const stageHunk = (hunk: ScmHunkInfo) => settle(() => rpc.call("scm.stageHunk", { ...target, rel: tab.rel, section: tab.section, index: hunk.index, hash: hunk.hash }), M.hunkFailed);
  const discardHunk = async (hunk: ScmHunkInfo) => {
    const name = tab.rel.slice(tab.rel.lastIndexOf("/") + 1);
    const fresh = diff?.original === null;
    const ok = await confirmAction(fresh ? M.trashFileTitle(name) : M.discardBlockTitle(name), fresh ? M.trashFileButton : M.discardBlockButton, fresh ? M.trashFileDetail : M.discardBlockDetail, "warning");
    if (ok) await settle(() => rpc.call("scm.discardHunk", { ...target, rel: tab.rel, index: hunk.index, hash: hunk.hash }), M.discardBlockFailed);
  };
  const wholeFile = () => settle(() => rpc.call(staged ? "scm.unstage" : "scm.stage", { ...target, paths: [tab.rel] }), M.hunkFailed);

  const latest = useRef({ stageHunk, discardHunk, wholeFile, busy });
  latest.current = { stageHunk, discardHunk, wholeFile, busy };
  const buttons = useMemo<HunkButton[]>(() => {
    const guard = (act: (hunk: ScmHunkInfo) => unknown) => (hunk: ScmHunkInfo) => !latest.current.busy && void act(hunk);
    const stage = guard((hunk) => latest.current.stageHunk(hunk));
    if (staged) return [{ label: M.unstageBlock, icon: "remove", act: stage }];
    return [
      { label: M.stageBlock, icon: "add", act: stage },
      { label: M.discardBlock, icon: "discard", act: guard((hunk) => latest.current.discardHunk(hunk)) },
    ];
  }, [staged]);

  const canStageFile = !!diff && (diff.hunks.length > 0 || diff.binary || diff.tooLarge);
  useEffect(
    () =>
      registerDiffNav(tab.key, {
        step: (direction) => handle.current?.step(direction),
        openFile: () => openFile({ workspaceId: tab.workspaceId, path: relative }),
        fileAction: canStageFile ? { label: staged ? M.unstage : M.stage, run: () => void latest.current.wholeFile() } : undefined,
      }),
    [tab.key, tab.workspaceId, relative, canStageFile, staged],
  );

  return (
    <div className="editor scm-diff-editor" style={{ display: active ? "flex" : "none" }} data-testid="scm-diff">
      <DiffCrumbs tabKey={tab.key} workspaceId={tab.workspaceId} path={relative} />
      <ScmDiffBody tab={tab} diff={diff} error={error} buttons={buttons} handleRef={handle} />
    </div>
  );
}

function ScmDiffBody({ tab, diff, error, buttons, handleRef }: { tab: ScmDiffTab; diff: ScmFileDiff | null; error: string | null; buttons: HunkButton[]; handleRef: RefObject<MountedDiff | null> }) {
  if (error && !diff) return <div className="editor-error">{M.diffLoadFailed(error)}</div>;
  if (!diff) return <div className="empty-hint">{M.loading}</div>;
  if (diff.binary) return <Notice title={M.diffBinary} text={M.diffBinaryText} />;
  if (diff.tooLarge) return <Notice title={M.diffTooLarge} text={M.diffTooLargeText} />;
  if (diff.original === diff.modified || (diff.original === null && diff.modified === null)) return <Notice title={M.diffNoChanges} text={M.diffNoChangesText} />;
  return <HunkEditor tab={tab} diff={diff} buttons={buttons} handleRef={handleRef} />;
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div className="changes-empty">
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

type MountedDiff = { step: (direction: 1 | -1) => void; scroller: HTMLElement; lspView: EditorView | null; measure: () => void; destroy: () => void };
type MountOptions = { tab: ScmDiffTab; diff: ScmFileDiff; buttons: HunkButton[]; lsp: DiffLspTarget | null };

function HunkEditor({ tab, diff, buttons, handleRef }: { tab: ScmDiffTab; diff: ScmFileDiff; buttons: HunkButton[]; handleRef: RefObject<MountedDiff | null> }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const lspViewRef = useRef<EditorView | null>(null);
  const scrollRef = useRef(0);
  const [requested] = useDiffView();
  const autoInline = useDefaults().diffInlineWhenNarrow;
  const hostWidth = useHostWidth(hostRef);
  const { mode } = chooseDiffMode(requested, hostWidth, autoInline);
  const measured = hostWidth !== null;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !measured) return;
    const lsp = tab.section === "changes" && diff.modified !== null ? diffLspTarget(tab.workspaceId, tab.path, true) : null;
    const mounted = mode === "split" ? mountSplit(host, { tab, diff, buttons, lsp }) : mountInline(host, { tab, diff, buttons, lsp });
    handleRef.current = mounted;
    lspViewRef.current = mounted.lspView;
    relabelCollapsed(host);
    requestAnimationFrame(() => (mounted.scroller.scrollTop = scrollRef.current));
    const observer = new MutationObserver(() => relabelCollapsed(host));
    observer.observe(host, { childList: true, subtree: true });
    const onScroll = () => (scrollRef.current = mounted.scroller.scrollTop);
    mounted.scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      mounted.scroller.removeEventListener("scroll", onScroll);
      mounted.destroy();
      handleRef.current = null;
      lspViewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, tab.path, tab.rel, tab.section, tab.workspaceId, buttons, mode, measured, handleRef]);

  useEffect(() => subscribeEditorFont(() => handleRef.current?.measure()), [handleRef]);

  return (
    <>
      <div className="editor-host file-diff-host scm-diff-host" data-mode={mode} ref={hostRef} />
      <DiffContextMenu host={hostRef} lspView={() => lspViewRef.current} workspaceId={tab.workspaceId} />
    </>
  );
}

function useHostWidth(hostRef: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const read = () => {
      const next = host.clientWidth;
      if (next > 0) setWidth((prev) => (prev === next ? prev : next));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(host);
    return () => observer.disconnect();
  }, [hostRef]);
  return width;
}

function mountInline(host: HTMLElement, { tab, diff, buttons, lsp }: MountOptions): MountedDiff {
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: initialModifiedText(lsp, diff.modified ?? ""),
      extensions: [
        hunkGutter(diff.hunks, buttons),
        diffCodeExtensions(tab.path, false, undefined, lsp),
        unifiedMergeView({ original: diff.original ?? "", mergeControls: false, collapseUnchanged: COLLAPSE_UNCHANGED, diffConfig: DIFF_CONFIG }),
        EditorView.contentAttributes.of({ "aria-label": tab.rel }),
      ],
    }),
  });
  const unbind = lsp ? bindDiffView(lsp, view) : null;
  const untrack = trackHover(view.dom, ".scm-hunk-mark");
  return {
    step: (direction) => stepChunk(view, direction),
    scroller: view.scrollDOM,
    lspView: lsp ? view : null,
    measure: () => view.requestMeasure(),
    destroy: () => {
      untrack();
      unbind?.();
      view.destroy();
    },
  };
}

function mountSplit(host: HTMLElement, { tab, diff, buttons, lsp }: MountOptions): MountedDiff {
  let merge: MergeView | null = null;
  const hunkAt = (box: HTMLElement) => {
    const chunk = merge?.chunks[Number(box.dataset.chunk)];
    if (!merge || !chunk) return null;
    return hunkForLines(diff.hunks, chunkLines(merge.a.state.doc, chunk.fromA, chunk.toA), chunkLines(merge.b.state.doc, chunk.fromB, chunk.toB));
  };
  const renderControl = () => {
    const box = document.createElement("div");
    box.className = "split-chunk-buttons";
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    const actions = document.createElement("div");
    actions.className = "split-chunk-actions";
    actions.append(...buttons.map((button) => hunkActionButton(button, () => hunkAt(box))));
    box.append(actions);
    return box;
  };
  merge = new MergeView({
    parent: host,
    a: { doc: diff.original ?? "", extensions: [diffCodeExtensions(tab.path, false)] },
    b: { doc: initialModifiedText(lsp, diff.modified ?? ""), extensions: [diffCodeExtensions(tab.path, false, undefined, lsp), EditorView.contentAttributes.of({ "aria-label": tab.rel })] },
    revertControls: "a-to-b",
    renderRevertControl: renderControl,
    collapseUnchanged: COLLAPSE_UNCHANGED,
    diffConfig: DIFF_CONFIG,
  });
  const view = merge;
  const unbind = lsp ? bindDiffView(lsp, view.b) : null;
  const unwatch = watchChunkBoxes(view);
  const untrack = trackHover(view.dom, ".cm-merge-revert > .split-chunk-buttons");
  return {
    step: (direction) => stepChunk(view.b, direction),
    scroller: view.dom,
    lspView: lsp ? view.b : null,
    measure: () => {
      view.a.requestMeasure();
      view.b.requestMeasure();
    },
    destroy: () => {
      untrack();
      unwatch();
      unbind?.();
      view.destroy();
    },
  };
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
