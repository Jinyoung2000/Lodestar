import { toggleBlockComment } from "@codemirror/commands";
import { unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, type MouseSelectionStyle } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import "./fileView.css";
import "./editorMenu.css";
import { armEscapeTab, noteKeyForTabFocus } from "./tabFocus";
import { editorFocusHeld } from "./editorFocusHold";
import { attachDoc, checkDisk, detachDoc, docMirror, formatDoc, resolveConflict, restoreHotDoc, saveAsTab, saveTab, setDocReadOnly, syncDirty, toggleCompare, useDocConflict, useDocFlags } from "./editorDocs";
import { EditorApproval } from "./EditorApproval";
import { isImagePath } from "./fileKind";
import { BinaryNotice, ImagePreview } from "./FilePreview";
import { FV } from "./fileViewStrings";
import { subscribeEditorFont } from "./editorFont";
import { conflictExtension } from "./conflictMarkers";
import { ConflictBar } from "./ConflictBar";
import { isChordPending } from "./shortcuts";
import { findWidget } from "./findWidget";
import { diffFeedbackExtension } from "./diffFeedbackEditor";
import { changeGutter, setGutterBase } from "./changeGutter";
import { quickDiff } from "./quickDiffPeek";
import { gitBlame } from "./gitBlame";
import { diffMarks, QUICK_DIFF_CONFIG } from "./diffMarks";
import { feedbackAgentFor } from "./diffFeedbackState";
import { quickAnchorExtension, setQuickAnchor } from "./quickAnchor";
import { editorMessage } from "./editorMessage";
import { gotoProblem } from "./problemActions";
import { openQuickFix } from "./quickFix";
import { copyTypeAtCursor, type CopyKind } from "./typeCopy";
import { editorSyntax } from "./editorSyntax";
import { Breadcrumbs } from "./Breadcrumbs";
import { breadcrumbSymbols } from "./breadcrumbSymbols";
import { MissingFile } from "./MissingFile";
import { FileTypeIcon } from "./FileTypeIcon";
import { languageFor } from "./languages";
import { ChevronLeft, ChevronRight, Codicon, References } from "./icons";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { goToReferences, revealDefinitionAside } from "./peekCommands";
import { cmdClickDefinition, lspDocument, lspKeys, lspViewExtensions } from "./editorLsp";
import { LspMenuItems } from "./LspMenu";
import { closeEditorWidgets, intellisenseExtension } from "./intellisenseKeys";
import { insertLineAbove } from "./editorPresetCommands";
import { presetKeys } from "./editorPresetKeys";
import { registerWidgetDismisser } from "./editorWidgets";
import { rpc } from "./rpc";
import { activeTab, flash, getState, setState, useStore, type FileTab, type FileTarget, type UntitledTab } from "./store";
import { foreignFolder } from "./tabFolder";
import { onWorkspaceChanged } from "./workspaceEvents";
import { clampEditorPos, noteWindowChanged, registerEditorReader, takeEditorRestore, takeHotRestore, takeHotSkipped, type EditorPos } from "./windowState";
import { S } from "./strings";
import {
  absolutePath,
  goBack,
  goForward,
  diffWorkspaceOf,
  focusedViewKey,
  languageIdFor,
  registerView,
  unregisterView,
  viewFor,
} from "./lsp";
import { hint } from "./hint";
import "./editorCommandTarget";
import { editorBase, editorOptionExtensions } from "./editorBase";
import { currentEditorOptions, subscribeEditorOptions } from "./editorOptions";
import { eolChanged, eolExtension } from "./editorEol";
import { failedServers, lspSummary } from "./lspServers";
import { useCommandKey } from "./commandKeys";

type Props = { tab: FileTab | UntitledTab; active: boolean };

export function Editor({ tab, active }: Props) {
  const backKey = useCommandKey("editor:navigateBack") ?? "⌃-";
  const forwardKey = useCommandKey("editor:navigateForward") ?? "⌃⇧-";
  const tabKey = tab.key;
  const workspaceId = tab.workspaceId;
  const path = tab.kind === "file" ? tab.path : null;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compareRef = useRef(new Compartment());
  const optionsRef = useRef(new Compartment());
  const wantFocusRef = useRef(false);
  const restoreScrollRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [binary, setBinary] = useState(false);
  const [large, setLarge] = useState(false);
  const [blobSize, setBlobSize] = useState<number | null>(null);
  const image = isImagePath(path);
  const isHtml = path !== null && /\.html?$/i.test(path);
  const [htmlPreview, setHtmlPreview] = useState<string | null>(null);
  const previewSyncRef = useRef<(() => void) | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const pendingReveal = useStore((s) => s.pendingReveal[tabKey]);
  const lspStatus = useStore((s) => s.lspStatus[workspaceId]);
  const lspInfo = useStore((s) => s.lspInfo[workspaceId]);
  const lspFallback = useStore((s) => s.lspFallback[workspaceId]);
  const lspServers = useStore((s) => s.lspServers[workspaceId]);
  const conflict = useDocConflict(tabKey);
  const flags = useDocFlags(tabKey);
  const foreignKey = useStore((s) => {
    const pane = s.panes.find((p) => p.id === s.activePaneId);
    const agent = pane?.kind === "agent" ? s.agents.find((a) => a.id === pane.agentId) : undefined;
    const workspace = s.workspaces.find((w) => w.id === workspaceId);
    const found = foreignFolder(workspace?.dir, path, agent, agent ? s.gitInfo[agent.id]?.repoRoot : null);
    if (!found) return null;
    const project = s.workspaces.find((w) => w.id === (workspace?.parentId ?? workspaceId))?.name ?? found.folder.slice(found.folder.lastIndexOf("/") + 1);
    return `${project}\n${found.file}\n${found.session}`;
  });
  const [foreignProject, foreignFile, foreignSession] = foreignKey ? foreignKey.split("\n") : [null, null, null];
  const languageId = path === null ? null : languageIdFor(path);

  useEffect(() => {
    let disposed = false;
    let view: EditorView | null = null;
    let offPosReader: (() => void) | null = null;
    let offWidgets: (() => void) | null = null;
    let offFocusOut: (() => void) | null = null;
    let offGutter: (() => void) | null = null;
    const create = (text: string, mtimeMs: number | null) => {
      if (disposed || !hostRef.current) return;
      const isBinary = text.includes("\u0000");
      setBinary(isBinary);
      setLarge(text.length > LARGE_FILE_CHARS);
      view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: text,
          extensions: [
            ...editorExtensions(workspaceId, path, languageId, isBinary, text.includes("\r\n") ? "\r\n" : null, compareRef.current, optionsRef.current, text),
            ...(path === null ? [] : [conflictExtension(tabKey), docMirror(tabKey), breadcrumbSymbols(tabKey)]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged || eolChanged(update)) syncDirty(tabKey);
              if (update.selectionSet || update.docChanged) noteWindowChanged();
              if (update.docChanged) previewSyncRef.current?.();
            }),
          ],
        }),
      });
      viewRef.current = view;
      registerView(tabKey, view);
      const created0 = view;
      offWidgets = registerWidgetDismisser(() => closeEditorWidgets(created0));
      const onFocusOut = (event: FocusEvent) => {
        const next = event.relatedTarget;
        if (!created0.dom.isConnected || (next instanceof Node && created0.dom.contains(next))) return;
        closeEditorWidgets(created0);
      };
      created0.dom.addEventListener("focusout", onFocusOut);
      offFocusOut = () => created0.dom.removeEventListener("focusout", onFocusOut);
      if (wantFocusRef.current && !editorFocusHeld(tabKey)) view.focus();
      attachDoc({ key: tabKey, workspaceId, path, view, savedDoc: view.state.doc, baseMtimeMs: mtimeMs });
      const hot = takeHotRestore(tabKey);
      if (hot) restoreHotDoc(tabKey, hot);
      else if (takeHotSkipped(tabKey)) flash(FV.hotExitTooLarge(path ?? S.untitledName(tab.kind === "untitled" ? tab.n : 0)), "warning");
      const created = view;
      const saved = getState().pendingReveal[tabKey] ? null : takeEditorRestore(tabKey);
      let last: EditorPos | null = saved ? clampEditorPos(saved, created.state.doc.length) : null;
      if (last) {
        created.dispatch({ selection: { anchor: last.anchor, head: last.head } });
        restoreScrollRef.current = last.scrollTop;
        requestAnimationFrame(() => applyRestoredScroll(created, restoreScrollRef));
      }
      offPosReader = registerEditorReader(tabKey, () => {
        const main = created.state.selection.main;
        if (created.dom.offsetParent !== null && restoreScrollRef.current === null) last = { anchor: main.anchor, head: main.head, scrollTop: created.scrollDOM.scrollTop };
        else if (last) last = { ...last, anchor: main.anchor, head: main.head };
        return last;
      });
      created.scrollDOM.addEventListener("scroll", noteWindowChanged, { passive: true });
      const reveal = getState().pendingReveal[tabKey];
      if (isHtml && reveal?.line === undefined && reveal?.search === undefined) setHtmlPreview(created.state.doc.toString());
      consumeReveal(tabKey, view);
      if (path !== null && !isBinary && text.length <= LARGE_FILE_CHARS) offGutter = keepGutterBase(created, workspaceId, path);
    };
    setBlobSize(null);
    setError(null);
    setMissing(false);
    if (image) return;
    if (path === null) create("", null);
    else
      void rpc
        .call("files.read", { workspaceId, path })
        .then(({ text, mtimeMs, binary: isBlob, size, readOnly }) => {
          if (text === null) {
            if (!disposed) setMissing(true);
            return;
          }
          if (isBlob) {
            if (!disposed) setBlobSize(size ?? 0);
            return;
          }
          create(text, mtimeMs ?? null);
          if (readOnly) setDocReadOnly(tabKey, true);
        })
        .catch((e: Error) => setError(e.message));

    return () => {
      disposed = true;
      offPosReader?.();
      offWidgets?.();
      offFocusOut?.();
      offGutter?.();
      if (view) {
        unregisterView(tabKey, view);
        detachDoc(tabKey, view);
        view.destroy();
      }
      viewRef.current = null;
    };
  }, [workspaceId, path, tabKey, languageId, image, reloadNonce]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: compareRef.current.reconfigure(conflict?.comparing ? [unifiedMergeView({ original: conflict.diskText, mergeControls: false, gutter: true, diffConfig: QUICK_DIFF_CONFIG }), diffMarks()] : []) });
  }, [conflict?.comparing, conflict?.diskText]);

  useEffect(() => {
    if (pendingReveal && viewRef.current) consumeReveal(tabKey, viewRef.current);
  }, [pendingReveal, tabKey]);

  useEffect(
    () =>
      subscribeEditorOptions((options) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ effects: optionsRef.current.reconfigure(editorOptionExtensions(options, { path, languageId, text: view.state.doc.toString() })) });
        view.requestMeasure();
      }),
    [path, languageId],
  );

  useEffect(() => subscribeEditorFont(() => viewRef.current?.requestMeasure()), []);

  const focused = useStore((s) => s.activeTabKey === tabKey);
  wantFocusRef.current = active && focused;
  useEffect(() => {
    if (!active) return;
    viewRef.current?.requestMeasure();
    void checkDisk(tabKey);
    const view = viewRef.current;
    if (view && restoreScrollRef.current !== null) requestAnimationFrame(() => applyRestoredScroll(view, restoreScrollRef));
  }, [active, tabKey]);
  useEffect(() => {
    if (active && focused && !editorFocusHeld(tabKey)) viewRef.current?.focus();
  }, [active, focused]);

  const previewOn = htmlPreview !== null;
  useEffect(() => setHtmlPreview(null), [path]);
  useEffect(() => {
    if (!previewOn) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    previewSyncRef.current = () => {
      clearTimeout(timer);
      timer = setTimeout(() => viewRef.current && setHtmlPreview(viewRef.current.state.doc.toString()), 300);
    };
    return () => {
      clearTimeout(timer);
      previewSyncRef.current = null;
    };
  }, [previewOn]);
  const toggleHtmlPreview = () => setHtmlPreview((before) => (before === null ? (viewRef.current?.state.doc.toString() ?? "") : null));

  return (
    <div className="editor" data-lsp-info={lspSummary(lspInfo, lspServers)} style={{ display: active ? "flex" : "none" }}>
      <div className="pane-header">
        <Button size="icon" aria-label={S.backKey(backKey)} title={S.backKey(backKey)} onClick={goBack}>
          <ChevronLeft />
        </Button>
        <Button size="icon" aria-label={S.forwardKey(forwardKey)} title={S.forwardKey(forwardKey)} onClick={goForward}>
          <ChevronRight />
        </Button>
        {path === null ? (
          <>
            <FileTypeIcon name="" />
            <span className="editor-path">{S.untitledName(tab.kind === "untitled" ? tab.n : 0)}</span>
          </>
        ) : (
          <Breadcrumbs tabKey={tabKey} workspaceId={workspaceId} path={path} deleted={!!flags.deleted} />
        )}
        {flags.deleted && (
          <span className="editor-foreign" title={FV.deletedTip}>
            {FV.deletedSuffix}
          </span>
        )}
        {flags.readOnly && !blobSize && !image && path !== null && (
          <Button size="icon" aria-label={FV.readOnlyTip(isOutsidePath(path))} title={FV.readOnlyTip(isOutsidePath(path))} data-testid="readonly-lock" onClick={() => void saveAsTab(tabKey)}>
            <Codicon name="lock" size={14} />
          </Button>
        )}
        {foreignProject && foreignFile && foreignSession && (
          <span className="editor-foreign" title={S.otherFolderTitle(foreignFile, foreignSession)} data-testid="editor-foreign">
            <Codicon name="repo" size={12} />
            {foreignProject}
          </span>
        )}
        {languageId && lspStatus === "error" && (
          <span className="editor-lsp" title={S.lspError} data-state="error" data-testid="lsp-error">
            <Codicon name="warning" size={14} />
          </span>
        )}
        {languageId &&
          failedServers(lspServers).map((server) => (
            <span key={server.label} className="editor-lsp" title={server.reason} data-state="error" data-testid="lsp-server-failed">
              <Codicon name="warning" size={14} />
              {server.label}
            </span>
          ))}
        {languageId && lspFallback && (
          <span className="editor-lsp" title={lspFallback.reason} data-testid="lsp-fallback">
            {lspFallback.label}
          </span>
        )}
        <span className="spacer" />
        {isHtml && !error && !missing && (
          <Button
            size="icon"
            variant={previewOn ? "ghost-on" : "ghost"}
            aria-label={previewOn ? S.htmlShowSource : S.htmlShowPreview}
            title={previewOn ? S.htmlShowSource : S.htmlShowPreview}
            aria-pressed={previewOn}
            data-testid="html-preview-toggle"
            onClick={toggleHtmlPreview}
          >
            <Codicon name={previewOn ? "code" : "open-preview"} />
          </Button>
        )}
        {languageId && (
          <Button size="icon" aria-label={S.referencesKey} title={S.referencesKey} onClick={() => viewRef.current && void goToReferences(viewRef.current, workspaceId)}>
            <References />
          </Button>
        )}
      </div>
      {tab.kind === "file" && <ConflictBar tabKey={tabKey} workspaceId={workspaceId} path={tab.path} />}
      {tab.kind === "file" && <EditorApproval workspaceId={workspaceId} path={tab.path} />}
      {conflict && (
        <div className="editor-banner" role="alert" data-testid="disk-conflict">
          <Codicon name="error" className="editor-banner-icon" />
          <span className="editor-banner-text" title={conflict.reason === "save" ? S.saveFailedNewer(path ? path.slice(path.lastIndexOf("/") + 1) : S.untitledName(0)) : S.diskNewer}>
            {conflict.reason === "save" ? FV.conflictSaveShort : FV.conflictShort}
          </span>
          <Button size="sm" variant="primary" title={FV.compareTip} aria-label={conflict.comparing ? S.hideCompare : S.compare} onClick={() => toggleCompare(tabKey)}>
            <Codicon name="diff" size={14} />
            <span className="editor-banner-label">{conflict.comparing ? S.hideCompare : S.compare}</span>
          </Button>
          <Button size="sm" variant="secondary" title={FV.overwriteTip} aria-label={S.overwrite} onClick={() => void resolveConflict(tabKey)}>
            <Codicon name="save" size={14} />
            <span className="editor-banner-label">{S.overwrite}</span>
          </Button>
        </div>
      )}
      {binary && <div className="editor-banner">{S.binaryReadOnly}</div>}
      {large && !binary && <div className="editor-banner">{S.largeFileLimited}</div>}
      {image && path !== null ? (
        <ImagePreview workspaceId={workspaceId} path={path} />
      ) : blobSize !== null && path !== null ? (
        <BinaryNotice workspaceId={workspaceId} path={path} size={blobSize} />
      ) : missing && path !== null ? (
        <MissingFile workspaceId={workspaceId} path={path} onCreated={() => setReloadNonce((n) => n + 1)} />
      ) : error ? (
        <div className="editor-error">{error}</div>
      ) : (
        <>
        {htmlPreview !== null && <iframe className="html-preview" title={S.htmlPreviewTitle} sandbox="allow-scripts" srcDoc={htmlPreview} data-testid="html-preview" />}
        <div
          className="editor-host"
          ref={hostRef}
          style={previewOn ? { display: "none" } : undefined}
          onContextMenu={(e) => {
            e.preventDefault();
            const view = viewRef.current;
            const caret = e.clientX === 0 && e.clientY === 0 && view ? view.coordsAtPos(view.state.selection.main.head) : null;
            setMenu(caret ? { x: caret.left, y: caret.bottom } : { x: e.clientX, y: e.clientY });
          }}
        />
        </>
      )}
      {menu && (
        <DropdownMenu open onOpenChange={(open) => !open && setMenu(null)}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="menu-anchor" style={{ left: menu.x, top: menu.y }} tabIndex={-1} aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" data-testid="editor-menu" onCloseAutoFocus={(e) => e.preventDefault()}>
            {languageId && (
              <>
                <LspMenuItems view={() => viewRef.current} workspaceId={workspaceId} />
                <DropdownMenuSeparator />
              </>
            )}
            {path !== null && (
              <>
                <DropdownMenuItem onSelect={() => void formatDoc(tabKey, false, false)}>
                  {S.formatDocument}
                  <span className="faint xs menu-hint">⌥⇧F</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void formatDoc(tabKey, true, false)}>
                  {S.formatSelection}
                  <span className="faint xs menu-hint">⌘K ⌘F</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={() => void saveTab(tabKey)}>
              {S.save}
              <span className="faint xs menu-hint">⌘S</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function selectionTab() {
  const key = focusedViewKey();
  return (key && getState().tabs.find((t) => t.key === key)) || activeTab();
}

export function currentSelection() {
  const tab = selectionTab();
  if (!tab || tab.kind !== "file") return null;
  const view = viewFor(tab.key);
  if (!view) return { workspaceId: tab.workspaceId, path: tab.path, startLine: null, endLine: null, text: null };
  const range = view.state.selection.main;
  if (range.empty) return { workspaceId: tab.workspaceId, path: tab.path, startLine: null, endLine: null, text: null };
  const doc = view.state.doc;
  const from = doc.lineAt(range.from);
  const to = doc.lineAt(range.to);
  return {
    workspaceId: tab.workspaceId,
    path: tab.path,
    startLine: from.number,
    endLine: range.to === to.from && to.number > from.number ? to.number - 1 : to.number,
    text: doc.sliceString(from.from, range.to === to.from && to.number > from.number ? doc.line(to.number - 1).to : to.to),
  };
}

function activeLspView() {
  const focusedKey = focusedViewKey();
  const focused = focusedKey ? viewFor(focusedKey) : null;
  if (focused && diffWorkspaceOf(focused)) return focused;
  const tab = activeTab();
  const fileTab = tab && tab.kind === "file" ? tab : null;
  const view = fileTab ? viewFor(fileTab.key) : null;
  if (!view || !fileTab || !languageIdFor(fileTab.path)) {
    hint(S.quickFixNone);
    return null;
  }
  return view;
}

export function definitionAsideActive() {
  const view = activeLspView();
  const tab = activeTab();
  const workspaceId = view ? (diffWorkspaceOf(view) ?? (tab && tab.kind === "file" ? tab.workspaceId : null)) : null;
  if (view && workspaceId) void revealDefinitionAside(view, workspaceId);
}

export function quickFixActive() {
  const view = activeLspView();
  if (view) void openQuickFix(view);
}

export function gotoProblemActive(direction: 1 | -1) {
  const view = activeLspView();
  if (view) gotoProblem(view, direction);
}

export function copyTypeActive(kind: CopyKind) {
  const view = activeLspView();
  return view ? copyTypeAtCursor(view, kind) : Promise.resolve();
}

export function startQuickAsk() {
  const selection = currentSelection();
  const tab = selectionTab();
  const view = tab && tab.kind === "file" ? viewFor(tab.key) : null;
  if (!tab || !view || !selection || selection.startLine == null || selection.text == null) {
    hint(S.selectCodeFirst);
    return;
  }
  const range = view.state.selection.main;
  view.dispatch({ effects: setQuickAnchor.of({ from: range.from, to: range.to }) });
  setState({
    quick: {
      run: null,
      workspaceId: selection.workspaceId,
      path: selection.path,
      startLine: selection.startLine,
      endLine: selection.endLine!,
      text: selection.text,
      tabKey: tab.key,
      from: range.from,
      to: range.to,
      rel: null,
    },
  });
}

const LARGE_FILE_CHARS = 2 * 1024 * 1024;

export const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--editor-bg)", color: "var(--editor-fg)" },
  ".cm-scroller": {
    fontFamily: "var(--editor-font-family)",
    fontSize: "var(--editor-font-size)",
    lineHeight: "var(--editor-line-height)",
    fontVariantLigatures: "var(--editor-ligatures)",
    fontFeatureSettings: "var(--editor-feature-settings)",
    letterSpacing: "var(--editor-letter-spacing, normal)",
  },
  ".cm-gutters": { backgroundColor: "var(--editor-bg)", color: "var(--editor-line-number)", border: "none", minWidth: "var(--size-gutter, 48px)" }, // lint-tokens: allow 줄 번호 열 48px (DiffFile 스펙), 토큰 제안: size-gutter
  ".cm-foldGutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center" },
  ".cm-foldGutter span": { lineHeight: "1" },
  ".cm-foldGutter span[title='Fold line']": { transform: "translateY(-0.25em)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--surface-hover)", color: "var(--fg-muted)", border: "none", borderRadius: "var(--radius-sm)", padding: "0 var(--space-1)", margin: "0 var(--space-1)" },
  ".cm-activeLine": { backgroundColor: "transparent", boxShadow: "inset 0 0 0 2px var(--editor-line-highlight)" }, // lint-tokens: allow
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--editor-line-number-active)" },
  ".cm-cursor": { borderLeftColor: "var(--editor-cursor)" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "var(--editor-selection-inactive) !important" },
  "&.cm-focused .cm-selectionBackground, &.cm-focused ::selection": { backgroundColor: "var(--editor-selection) !important" },
  ".cm-definition-link, .cm-definition-link *": { color: "var(--editor-link-active) !important", cursor: "pointer" },
  ".cm-definition-link": { textDecoration: "underline" },
  ".cm-tooltip.cm-lsp-hover-tooltip": { padding: "0 var(--space-2)" },
  ".cm-lsp-hover-tooltip pre, .cm-lsp-hover-tooltip code": { fontFamily: "var(--editor-font-family)", fontSize: "var(--editor-font-size)", lineHeight: "var(--editor-line-height)" },
  ".cm-lsp-hover-tooltip .cm-definition-preview pre": { margin: "0", padding: "0" },
  ".cm-tooltip-lint": { display: "none !important" },
  ".cm-lsp-hover-tooltip .cm-hover-block": { margin: "0 calc(-1 * var(--space-2))", padding: "var(--space-1) var(--space-2)" },
  ".cm-lsp-hover-tooltip .cm-hover-block + .cm-hover-block": { borderTop: "1px solid var(--hover-border)" },
  ".cm-lsp-hover-tooltip .cm-hover-section > :first-child": { marginTop: "0" },
  ".cm-lsp-hover-tooltip .cm-hover-section > :last-child": { marginBottom: "0" },
  ".cm-hover-diagnostic": { fontFamily: "var(--font-sans)", fontSize: "var(--editor-font-size)", lineHeight: "var(--editor-line-height)" },
  ".cm-hover-related-item": { fontFamily: "var(--font-sans)", fontSize: "var(--text-ui-sm)", lineHeight: "var(--leading-ui-sm)", color: "var(--fg-muted)" },
  ".cm-lsp-hover-tooltip .cm-hover-related pre": { margin: "0", padding: "0", color: "var(--hover-fg)" },
  ".cm-hover-code": { color: "var(--fg-muted)" },
  ".cm-hover-actions": { display: "flex", alignItems: "center", gap: "var(--space-3)", fontFamily: "var(--font-sans)", fontSize: "var(--text-ui-sm)" },
  ".cm-hover-action": { all: "unset", boxSizing: "border-box", display: "inline-flex", alignItems: "center", height: "var(--leading-ui-sm)", color: "var(--hover-link)", cursor: "pointer", whiteSpace: "nowrap" },
  ".cm-hover-action:hover": { textDecoration: "underline" },
  ".cm-definition-preview-more": { color: "var(--fg-muted)" },
  ".cm-selectionMatch": { backgroundColor: "var(--editor-selection-match)" },
  "&.cm-focused .cm-matchingBracket, .cm-matchingBracket": { backgroundColor: "var(--editor-bracket-match-bg)", outline: "1px solid var(--editor-bracket-match-border)" },
  ".cm-tooltip": { backgroundColor: "var(--hover-bg)", color: "var(--hover-fg)", border: "1px solid var(--hover-border)", borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-hover)", maxWidth: "var(--size-hover-max)", overflow: "hidden" },
  ".cm-tooltip .cm-lsp-documentation": { padding: "var(--space-1) var(--space-2)", fontFamily: "var(--font-sans)", fontSize: "var(--editor-font-size)", lineHeight: "var(--editor-line-height)", maxHeight: "calc(var(--size-chat) / 2)", overflowY: "auto" },
  ".cm-tooltip .cm-lsp-documentation p, .cm-tooltip .cm-lsp-documentation ul, .cm-tooltip .cm-lsp-documentation ol, .cm-tooltip .cm-lsp-documentation pre": { margin: "var(--space-2) 0" },
  ".cm-tooltip .cm-lsp-documentation > :first-child": { marginTop: "0" },
  ".cm-tooltip .cm-lsp-documentation > :last-child": { marginBottom: "0" },
  ".cm-tooltip .cm-lsp-documentation ul, .cm-tooltip .cm-lsp-documentation ol": { paddingLeft: "var(--space-4)" },
  ".cm-tooltip .cm-lsp-documentation pre": { fontFamily: "var(--editor-font-family)", fontSize: "var(--editor-font-size)", lineHeight: "var(--editor-line-height)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "0 calc(-1 * var(--space-2))", padding: "0 var(--space-2)" },
  ".cm-tooltip .cm-lsp-documentation pre:not(:last-child)": { marginBottom: "var(--space-1)", paddingBottom: "var(--space-1)", borderBottom: "1px solid var(--hover-border)" },
  ".cm-tooltip .cm-lsp-documentation code": { fontFamily: "var(--editor-font-family)", backgroundColor: "var(--code-block-bg)", borderRadius: "var(--radius-sm)", padding: "0 0.4em" },
  ".cm-tooltip .cm-lsp-documentation pre code": { backgroundColor: "transparent", padding: "0", borderRadius: "0" },
  ".cm-tooltip .cm-lsp-documentation a": { color: "var(--hover-link)" },
  ".cm-tooltip.cm-lsp-signature-tooltip": { maxWidth: "var(--size-hover-max)", maxHeight: "calc(var(--size-chat) / 2)", padding: "0", overflowY: "auto", fontFamily: "var(--font-sans)", fontSize: "var(--text-ui-sm)" },
  ".cm-lsp-signature-tooltip .cm-lsp-signature": { fontFamily: "var(--font-sans)", fontSize: "var(--text-ui-sm)", lineHeight: "var(--leading-ui-sm)", padding: "var(--space-1) var(--space-1_5)" },
  ".cm-tooltip.cm-lsp-signature-multiple .cm-lsp-signature": { paddingLeft: "var(--space-6)" },
  ".cm-lsp-signature-tooltip .cm-lsp-active-parameter": { color: "var(--hover-highlight)", fontWeight: "bold" },
  ".cm-lsp-signature-tooltip .cm-lsp-signature-documentation": { borderTop: "1px solid var(--hover-border)", padding: "var(--space-1) var(--space-1_5)" },
  ".cm-tooltip.cm-tooltip-autocomplete": { boxShadow: "var(--shadow-suggest)", minWidth: "var(--size-suggest-min)", maxWidth: "var(--size-suggest-min)", overflow: "visible" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { borderRadius: "inherit", fontFamily: "var(--editor-font-family)", fontSize: "var(--editor-font-size)", maxHeight: "calc(var(--editor-line-height) * 12)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { position: "relative", lineHeight: "var(--editor-line-height)", padding: "0 var(--space-2) 0 var(--space-1)", color: "var(--hover-fg)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--suggest-selected-bg)", color: "var(--suggest-selected-fg)" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "bold", color: "var(--hover-highlight)" },
  ".cm-completionDetail": { opacity: "0.6", marginLeft: "var(--space-2)", fontStyle: "normal" },
  ".cm-completionIcon": { opacity: "1", width: "var(--size-icon)", paddingRight: "var(--space-1)", fontSize: "var(--size-icon)", lineHeight: "1", textAlign: "center", color: "var(--symbol-default)", "&:after": { fontFamily: "codicon", fontSize: "var(--size-icon)", verticalAlign: "middle" } },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionIcon": { color: "var(--suggest-selected-fg)" },
  ".cm-completionIcon-variable": { color: "var(--symbol-variable)", "&:after": { content: "'\\ea88'" } },
  ".cm-completionIcon-field": { color: "var(--symbol-variable)", "&:after": { content: "'\\eb5f'" } },
  ".cm-completionIcon-function, .cm-completionIcon-method, .cm-completionIcon-constructor": { color: "var(--symbol-function)", "&:after": { content: "'\\ea8c'" } },
  ".cm-completionIcon-class": { color: "var(--symbol-class)", "&:after": { content: "'\\eb5b'" } },
  ".cm-completionIcon-struct": { "&:after": { content: "'\\ea91'" } },
  ".cm-completionIcon-enum, .cm-completionIcon-value": { color: "var(--symbol-class)", "&:after": { content: "'\\ea95'" } },
  ".cm-completionIcon-enumMember": { color: "var(--symbol-variable)", "&:after": { content: "'\\eb5e'" } },
  ".cm-completionIcon-event": { color: "var(--symbol-class)", "&:after": { content: "'\\ea86'" } },
  ".cm-completionIcon-interface": { color: "var(--symbol-variable)", "&:after": { content: "'\\eb61'" } },
  ".cm-completionIcon-constant": { "&:after": { content: "'\\eb5d'" } },
  ".cm-completionIcon-property": { "&:after": { content: "'\\eb65'" } },
  ".cm-completionIcon-keyword": { "&:after": { content: "'\\eb62'" } },
  ".cm-completionIcon-operator": { "&:after": { content: "'\\eb64'" } },
  ".cm-completionIcon-snippet": { "&:after": { content: "'\\eb66'" } },
  ".cm-completionIcon-namespace, .cm-completionIcon-module": { "&:after": { content: "'\\ea8b'" } },
  ".cm-completionIcon-type, .cm-completionIcon-typeParameter": { "&:after": { content: "'\\ea92'" } },
  ".cm-completionIcon-unit": { "&:after": { content: "'\\ea96'" } },
  ".cm-completionIcon-color": { "&:after": { content: "'\\eb5c'" } },
  ".cm-completionIcon-file": { "&:after": { content: "'\\eb60'" } },
  ".cm-completionIcon-folder": { "&:after": { content: "'\\ea83'" } },
  ".cm-completionIcon-reference": { "&:after": { content: "'\\ea94'" } },
  ".cm-completionIcon-text": { "&:after": { content: "'\\ea93'", fontSize: "var(--size-icon)", verticalAlign: "middle" } },
  ".cm-completionRowExtras": { display: "none" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionRowExtras": { display: "inline" },
  ".cm-completionInlineDetail": { marginLeft: "var(--space-2)", opacity: "0.7" },
  ".cm-completionReadMore": { display: "none", position: "absolute", insetInlineEnd: "var(--space-1)", top: "0", fontSize: "var(--size-icon)", lineHeight: "var(--editor-line-height)", cursor: "pointer", backgroundColor: "var(--suggest-selected-bg)", paddingInlineStart: "var(--space-1)" },
  ".cm-completionReadMore[data-has-info]": { display: "inline-block" },
  "&.cm-suggest-details-off .cm-completionInfo": { display: "none" },
  "&.cm-signature-dismissed .cm-lsp-signature-tooltip": { display: "none" },
  ".cm-completionInfo": { backgroundColor: "var(--hover-bg)", color: "var(--hover-fg)", border: "1px solid var(--hover-border)", borderRadius: "var(--radius-lg)", fontFamily: "var(--font-sans)" },
  ".cm-lintRange": { backgroundImage: "none", textDecorationLine: "underline", textDecorationStyle: "wavy", textDecorationSkipInk: "none" },
  ".cm-lintRange-error": { textDecorationColor: "var(--editor-error)" },
  ".cm-lintRange-warning": { textDecorationColor: "var(--editor-warning)" },
  ".cm-lintRange-info": { textDecorationColor: "var(--editor-info)" },
  ".cm-lintRange-hint": { textDecorationColor: "var(--editor-hint)" },
  ".cm-diagnostic": { padding: "var(--space-1) var(--space-2)", fontFamily: "var(--font-sans)", fontSize: "var(--editor-font-size)" },
  ".cm-diagnostic-error": { borderLeft: "var(--space-0_5) solid var(--editor-error)" },
  ".cm-diagnostic-warning": { borderLeft: "var(--space-0_5) solid var(--editor-warning)" },
  ".cm-diagnostic-info": { borderLeft: "var(--space-0_5) solid var(--editor-info)" },
  ".cm-diagnostic-hint": { borderLeft: "var(--space-0_5) solid var(--editor-hint)" },
  ".cm-panels": { backgroundColor: "var(--surface-base)", color: "var(--fg)" },
  ".cm-panel.cm-lsp-message": { padding: "var(--space-1) var(--space-6) var(--space-1) var(--space-2)", fontFamily: "var(--font-sans)", fontSize: "var(--text-ui-sm)", lineHeight: "var(--leading-ui-sm)" },
  ".cm-panel.cm-lsp-message-error": { borderLeft: "var(--space-0_5) solid var(--editor-error)" },
  ".cm-panel.cm-lsp-message-warning": { borderLeft: "var(--space-0_5) solid var(--editor-warning)" },
  ".cm-panel.cm-lsp-message-info": { borderLeft: "var(--space-0_5) solid var(--editor-info)" },
  ".cm-panel.cm-lsp-message button[type=submit]": {
    font: "inherit",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-ui-sm)",
    height: "var(--size-control-sm)",
    margin: "var(--space-1) 0",
    padding: "0 var(--space-2)",
    border: "1px solid transparent",
    borderRadius: "var(--radius-md)",
    background: "var(--surface-overlay)",
    color: "var(--fg)",
    cursor: "pointer",
  },
  ".cm-panel.cm-lsp-message button[type=submit]:hover": { background: "var(--surface-hover)" },
  ".cm-panel.cm-lsp-message button[name=close]": { color: "var(--fg-muted)", cursor: "pointer" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warning) 35%, transparent)" },
  ".cm-changedLine": { backgroundColor: "var(--diff-add-bg)" },
  ".cm-deletedChunk": { backgroundColor: "var(--diff-del-bg)" },
  ".cm-changedText": { background: "var(--diff-add-gutter)" },
  ".cm-deletedChunk .cm-deletedText": { background: "var(--diff-del-gutter)" },
  ".cm-wholeChangedLine": { backgroundImage: "linear-gradient(var(--diff-add-gutter), var(--diff-add-gutter))" },
  ".cm-deletedChunk .cm-wholeChangedLine": { backgroundImage: "linear-gradient(var(--diff-del-gutter), var(--diff-del-gutter))", marginLeft: "calc(-1 * var(--space-1_5))", paddingLeft: "var(--space-1_5)" },
  ".cm-wholeChangedLine .cm-changedText, .cm-deletedChunk .cm-wholeChangedLine .cm-deletedText": { background: "none" },
  ".cm-changedLineGutter": { backgroundColor: "var(--diff-add-bg)" },
  ".cm-deletedLineGutter": { backgroundColor: "var(--diff-del-bg)" },
  ".cm-collapsedLines": {
    background: "none",
    color: "var(--fg-muted)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-caption)",
    lineHeight: "var(--size-control-sm)",
    padding: "var(--space-2) calc(var(--space-2) + var(--space-0_5))",
  },
  ".cm-collapsedLines:before, .cm-collapsedLines:after": { content: "none" },
  ".cm-collapsed-inner": { display: "flex", alignItems: "center", gap: "var(--space-1_5)", height: "var(--size-control-sm)", padding: "0 var(--space-2)", borderRadius: "var(--radius-md)" },
  ".cm-collapsed-inner:before, .cm-collapsed-inner:after": { content: '""', flex: "1", height: "1px", background: "var(--find-widget-border)" },
  ".cm-collapsed-inner .codicon": { fontSize: "calc(var(--size-icon-sm) + var(--space-0_5))" },
  ".cm-collapsedLines:hover .cm-collapsed-inner": { background: "var(--surface-hover)" },
});

function movePage(view: EditorView, direction: 1 | -1) {
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const line = doc.lineAt(head);
  const target = doc.line(Math.min(Math.max(line.number + direction * 10, 1), doc.lines));
  view.scrollDOM.scrollTop += direction * 10 * view.defaultLineHeight;
  view.dispatch({ selection: EditorSelection.cursor(target.from + Math.min(head - line.from, target.length)) });
  return true;
}

function altClickCursor(view: EditorView, event: MouseEvent): MouseSelectionStyle | null {
  if (event.button !== 0 || !event.altKey || event.shiftKey || event.metaKey || event.ctrlKey) return null;
  const start = view.state.selection;
  const anchor = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  return {
    get(current) {
      const head = view.posAtCoords({ x: current.clientX, y: current.clientY }, false);
      return EditorSelection.create([...start.ranges, EditorSelection.range(anchor, head)], start.ranges.length);
    },
    update() {},
  };
}

function keepGutterBase(view: EditorView, workspaceId: string, path: string) {
  let live = true;
  let loading = false;
  const load = () => {
    if (loading) return;
    loading = true;
    rpc
      .call("files.headText", { workspaceId, path })
      .then(({ repo, text }) => {
        if (live && view.dom.isConnected) view.dispatch({ effects: setGutterBase.of(repo ? text : null) });
      })
      .catch(() => {})
      .finally(() => {
        loading = false;
      });
  };
  load();
  const offChanged = onWorkspaceChanged(workspaceId, load);
  window.addEventListener("focus", load);
  return () => {
    live = false;
    offChanged();
    window.removeEventListener("focus", load);
  };
}

function editorExtensions(workspaceId: string, path: string | null, fileLanguageId: string | null, binary: boolean, lineSeparator: string | null, compare: Compartment, options: Compartment, text: string): Extension[] {
  const large = text.length > LARGE_FILE_CHARS;
  const languageId = large ? null : fileLanguageId;
  const extensions: Extension[] = [
    Prec.highest(
      keymap.of([
        { key: "Mod-i", run: () => true },
        { key: "Mod-f", run: () => isChordPending() },
        { key: "Mod-ArrowLeft", run: () => isChordPending() },
        { key: "Mod-ArrowRight", run: () => isChordPending() },
        { key: "Mod-ArrowUp", run: () => isChordPending() },
        { key: "Mod-ArrowDown", run: () => isChordPending() },
        { key: "Shift-Mod-Enter", run: insertLineAbove },
        { key: "PageUp", run: (view) => movePage(view, -1) },
        { key: "PageDown", run: (view) => movePage(view, 1) },
        ...lspKeys(workspaceId),
      ]),
    ),
    intellisenseExtension,
    presetKeys,
    editorBase(),
    options.of(editorOptionExtensions(currentEditorOptions(), { path, languageId, text })),
    findWidget(),
    Prec.lowest(keymap.of([{ key: "Escape", run: () => (armEscapeTab(), false) }])),
    eolExtension(lineSeparator),
    EditorState.readOnly.of(binary),
    EditorView.editable.of(!binary),
    compare.of([]),
    path === null || large ? [] : changeGutter(quickDiff({ path, previewExtensions: [editorTheme, languageFor(path)] })),
    path === null || binary || large ? [] : gitBlame(workspaceId, path),
    path === null ? [] : languageFor(path),
    editorTheme,
    editorSyntax({ semantic: languageId !== null }),
    languageId ? lspViewExtensions(workspaceId, editorTheme) : [],
    quickAnchorExtension(),
    editorMessage(),
    path === null
      ? []
      : diffFeedbackExtension({
          get agentId() {
            return feedbackAgentFor(workspaceId, path) ?? "";
          },
          get path() {
            return absolutePath(workspaceId, path);
          },
          lineGlyph: false,
        }),
    Prec.highest(EditorView.mouseSelectionStyle.of(altClickCursor)),
    EditorView.domEventHandlers({
      keydown(event, view) {
        noteKeyForTabFocus(event);
        if (event.code !== "KeyA" || !event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey || event.isComposing) return false;
        event.preventDefault();
        return toggleBlockComment(view);
      },
    }),
    cmdClickDefinition(workspaceId),
  ];
  if (languageId && path !== null) {
    extensions.push(lspDocument(workspaceId, absolutePath(workspaceId, path), languageId));
  }
  return extensions;
}

function applyRestoredScroll(view: EditorView, ref: { current: number | null }) {
  const top = ref.current;
  if (top === null || view.dom.offsetParent === null) return;
  view.scrollDOM.scrollTo({ top, behavior: "instant" });
  setTimeout(() => {
    if (ref.current === top && Math.abs(view.scrollDOM.scrollTop - top) > 1) view.scrollDOM.scrollTo({ top, behavior: "instant" });
    if (ref.current === top) ref.current = null;
  }, 150);
}

function consumeReveal(tabKey: string, view: EditorView) {
  const target: FileTarget | undefined = getState().pendingReveal[tabKey];
  if (!target) return;
  setState((s) => {
    const { [tabKey]: _, ...rest } = s.pendingReveal;
    return { pendingReveal: rest };
  });
  const doc = view.state.doc;
  let pos: number | null = null;
  if (target.search) {
    const index = doc.toString().indexOf(target.search);
    if (index !== -1) pos = index;
  }
  if (pos == null && target.line) {
    const line = doc.line(Math.min(Math.max(target.line, 1), doc.lines));
    pos = Math.min(line.from + Math.max((target.column ?? 1) - 1, 0), line.to);
  }
  if (pos == null) return;
  const head = target.endColumn && target.line && !target.search ? Math.min(doc.line(Math.min(Math.max(target.line, 1), doc.lines)).from + target.endColumn - 1, doc.line(Math.min(Math.max(target.line, 1), doc.lines)).to) : null;
  const scroller = view.scrollDOM;
  scroller.style.scrollBehavior = "auto";
  const reveal = () => view.dispatch({ selection: head === null ? { anchor: pos! } : { anchor: pos!, head }, effects: EditorView.scrollIntoView(pos!, { y: "center" }) });
  reveal();
  if (!editorFocusHeld(tabKey)) view.focus();
  const settle = (left: number) => {
    if (!view.dom.isConnected) return;
    const coords = view.coordsAtPos(pos!);
    const box = scroller.getBoundingClientRect();
    if (box.height > 0 && (coords === null || coords.bottom < box.top || coords.top > box.bottom)) reveal();
    if (left > 0) requestAnimationFrame(() => settle(left - 1));
  };
  requestAnimationFrame(() => settle(3));
  setTimeout(() => {
    scroller.style.scrollBehavior = "";
  }, 300);
}

const isOutsidePath = (path: string) => path.startsWith("/") || path.startsWith("../");
