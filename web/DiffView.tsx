import { getChunks, getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { defaultChangeScope, type ChangedFile, type ChangeScope } from "../shared/protocol";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import { useDefaults } from "./defaults";
import { inlineDiffSource } from "./diffFeedbackEditor";
import { useFeedbackReveal } from "./diffFeedbackState";
import { discardChangedFile, FILE_REVISION_EVENT, keepChangedFile } from "./changeCommands";
import { DIFF_CONFIG } from "./diffMarks";
import { chunkPosition, inlineChunkControls, type ChunkPosition } from "./diffChunkHover";
import { revertedNewFile } from "./diffChunks";
import { COLLAPSE_UNCHANGED, diffCodeExtensions, mountSplitDiff, revealLine, stepChunk, type DiffHandle, type DiffHooks } from "./diffSplit";
import { bindDiffView, diffLspTarget, initialModifiedText, type DiffLspTarget } from "./diffLsp";
import { isMirroredUpdate } from "./viewMirror";
import { DiffContextMenu } from "./LspMenu";
import { chooseDiffMode, reportNarrow, SPLIT_GAP, SPLIT_MIN_PANE, splitFits, useDiffView, useSplitNarrow } from "./diffMode";
import { Breadcrumbs } from "./Breadcrumbs";
import { registerDiffNav } from "./diffNav";
import { subscribeEditorFont } from "./editorFont";
import { rpc } from "./rpc";
import { flash, openFile, refreshGit, useStore } from "./store";
import { onWorkspaceChanged } from "./workspaceEvents";
import { FileTypeIcon } from "./FileTypeIcon";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Codicon } from "./icons";

const REVEAL_FRESH_MS = 4000;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);

const eolOf = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n");
const withEol = (text: string, eol: "\n" | "\r\n") => (eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text);
const sameLines = (a: string, b: string) => a === b || a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n");

export function useOriginal(agentId: string, path: string, scope?: ChangeScope, file?: Pick<ChangedFile, "status" | "from">, enabled = true) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const keptApplies = !scope || !agent || scope === defaultChangeScope(agent) || scope === "branch" || scope === "session";
  const kept = useStore((s) => (keptApplies ? s.changes[agentId]?.find((c) => c.path === path) : undefined));
  const [gitOriginal, setGitOriginal] = useState<{ path: string; scope: ChangeScope | undefined; text: string | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const isAdded = file?.status === "A";
  const from = file?.status === "R" ? file.from : undefined;
  useEffect(() => {
    if (kept || isAdded || !enabled) return;
    let cancelled = false;
    void rpc
      .call("git.original", { agentId, path, scope, from })
      .then(({ text }) => !cancelled && setGitOriginal({ path, scope, text, error: null }))
      .catch((e: Error) => !cancelled && setGitOriginal({ path, scope, text: null, error: e.message }));
    return () => {
      cancelled = true;
    };
  }, [agentId, path, scope, from, kept, isAdded, attempt, enabled]);
  const retry = () => {
    setGitOriginal(null);
    setAttempt((n) => n + 1);
  };
  if (kept) return { loaded: true, original: kept.original, kept: true, error: null, retry };
  if (isAdded) return { loaded: true, original: null, kept: false, error: null, retry };
  if (gitOriginal && gitOriginal.path === path && gitOriginal.scope === scope) return { loaded: !gitOriginal.error, original: gitOriginal.text, kept: false, error: gitOriginal.error, retry };
  return { loaded: false, original: null, kept: false, error: null, retry };
}

export function BaseLoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="diff-empty diff-load-failed" role="alert">
      <span title={message}>{S.baseLoadFailed}</span>
      <Button onClick={onRetry}>{S.retry}</Button>
    </div>
  );
}

type Props = { agentId: string; workspaceId: string; path: string; original: string | null; scope: string; onResolved?: (resolved: boolean) => void; collapse?: boolean; wrap?: boolean; readOnly?: boolean; handleRef?: MutableRefObject<DiffHandle | null>; onPosition?: (position: ChunkPosition) => void };

export function FileDiff({ agentId, workspaceId, path, original, scope, onResolved, collapse = true, wrap = false, readOnly = false, handleRef: sharedHandle, onPosition }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ownHandle = useRef<DiffHandle | null>(null);
  const handleRef = sharedHandle ?? ownHandle;
  const originalRef = useRef(original ?? "");
  const baseMissing = useRef(original === null);
  const textRef = useRef<{ key: string; text: string; exists: boolean } | null>(null);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writePending = useRef(false);
  const diskRef = useRef<{ key: string; text: string | null } | null>(null);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const eolRef = useRef<"\n" | "\r\n">("\n");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [requested] = useDiffView();
  const [hostWidth, setHostWidth] = useState<number | null>(null);
  const instance = useId();
  const reveal = useFeedbackReveal();
  const revealed = useRef(0);
  const [mounts, setMounts] = useState(0);
  const autoInline = useDefaults().diffInlineWhenNarrow;
  const { mode, tooNarrow } = chooseDiffMode(requested, hostWidth, autoInline);
  const measured = hostWidth !== null;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const read = () => {
      const width = host.clientWidth;
      if (width > 0) setHostWidth((prev) => (prev === width ? prev : width));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const key = `${scope}|${instance}`;
    reportNarrow(key, requested === "split" && tooNarrow);
    return () => reportNarrow(key, false);
  }, [scope, instance, requested, tooNarrow]);

  useEffect(
    () => () => {
      if (writeTimer.current) clearTimeout(writeTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!measured) return;
    let disposed = false;
    const diskKey = `${agentId}\0${workspaceId}\0${path}\0${reload}`;

    const writeDisk = (next: string | null, after: () => Promise<unknown>) => {
      writeQueue.current = writeQueue.current
        .then(async () => {
          const known = diskRef.current;
          if (!known || known.key !== diskKey) return;
          const { text: now } = await rpc.call("files.read", { workspaceId, path });
          if (now !== known.text) {
            flash(S.quickFixConflict, "warning");
            setReload((n) => n + 1);
            return;
          }
          await rpc.call("files.write", { agentId, path, text: next });
          diskRef.current = { key: diskKey, text: next };
          await after();
        })
        .catch((e: Error) => flash(e.message))
        .finally(() => {
          if (writeTimer.current === null) writePending.current = false;
        });
    };

    const hooks: DiffHooks = {
      onText: (docText, reverted) => {
        const text = withEol(docText, eolRef.current);
        textRef.current = { key: diskKey, text, exists: textRef.current?.exists ?? true };
        if (writeTimer.current) clearTimeout(writeTimer.current);
        if (revertedNewFile({ baseMissing: baseMissing.current, reverted, original: originalRef.current, text })) {
          writePending.current = true;
          writeTimer.current = setTimeout(() => {
            writeTimer.current = null;
            writeDisk(null, () => rpc.call("changes.clear", { agentId, path }).then(() => refreshGit(agentId)));
          }, 150);
          return;
        }
        writePending.current = true;
        writeTimer.current = setTimeout(() => {
          writeTimer.current = null;
          writeDisk(text, () => refreshGit(agentId));
        }, 150);
      },
      onOriginal: (docText) => {
        if (sameLines(docText, originalRef.current)) return;
        const next = withEol(docText, originalRef.current === "" ? eolRef.current : eolOf(originalRef.current));
        originalRef.current = next;
        if (next !== "") baseMissing.current = false;
        void rpc.call("changes.setOriginal", { agentId, path, original: next });
      },
      onResolved: (resolved) => onResolved?.(resolved),
      onPosition: (position) => onPosition?.(position),
    };

    const known = textRef.current?.key === diskKey ? textRef.current : null;
    void (
      known
        ? Promise.resolve(known)
        : rpc.call("files.read", { workspaceId, path }).then(({ text }) => {
            diskRef.current = { key: diskKey, text };
            return { text: text ?? "", exists: text !== null };
          })
    )
      .then(({ text, exists }) => {
        if (disposed || !hostRef.current) return;
        const lsp = diffLspTarget(workspaceId, path, exists);
        const start = initialModifiedText(lsp, text);
        eolRef.current = eolOf(start);
        textRef.current = { key: diskKey, text: start, exists };
        const base = originalRef.current;
        handleRef.current = mode === "split" ? mountSplitDiff(hostRef.current, { agentId, path, original: base, text: start, hooks, collapse, wrap, lsp }) : mountInlineDiff(hostRef.current, { agentId, path, original: base, text: start, hooks, collapse, wrap, lsp });
        relabelCollapsed(hostRef.current);
        setMounts((n) => n + 1);
      })
      .catch((e: Error) => setError(e.message));

    const off = rpc.onEvent((event) => {
      if (event.type !== "timelineUpsert" || event.item.kind !== "tool" || event.item.status !== "done") return;
      if (!EDIT_TOOLS.has(event.item.name)) return;
      if (event.item.name !== "Bash" && event.item.input.file_path !== path) return;
      void rpc.call("files.read", { workspaceId, path }).then(({ text }) => {
        const current = handleRef.current;
        if (!current || text === null || sameLines(current.text(), initialModifiedText(diffLspTarget(workspaceId, path, true), text))) return;
        if (writeTimer.current) clearTimeout(writeTimer.current);
        writePending.current = false;
        setReload((n) => n + 1);
      });
    });
    const offWorkspace = onWorkspaceChanged(workspaceId, () => {
      void rpc.call("files.read", { workspaceId, path }).then(({ text }) => {
        const current = handleRef.current;
        if (disposed || !current || text === null || sameLines(current.text(), initialModifiedText(diffLspTarget(workspaceId, path, true), text))) return;
        if (writePending.current) return;
        setReload((n) => n + 1);
      });
    });
    const observer = new MutationObserver(() => hostRef.current && relabelCollapsed(hostRef.current));
    if (hostRef.current) observer.observe(hostRef.current, { childList: true, subtree: true });

    return () => {
      disposed = true;
      off();
      offWorkspace();
      observer.disconnect();
      handleRef.current?.destroy();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, workspaceId, path, reload, mode, measured, collapse, wrap]);

  useEffect(() => {
    if (!reveal || reveal.path !== path || reveal.agentId !== agentId || revealed.current === reveal.nonce || !handleRef.current) return;
    if (Date.now() - reveal.at > REVEAL_FRESH_MS) return;
    revealed.current = reveal.nonce;
    handleRef.current.reveal(reveal.line);
  }, [reveal, mounts, agentId, path]);

  useEffect(() => subscribeEditorFont(() => handleRef.current?.measure()), []);

  if (error) return <div className="editor-error">{error}</div>;
  return (
    <>
      <div className="editor-host file-diff-host" data-mode={mode} data-readonly={readOnly ? "" : undefined} data-scroll-x={mode === "split" && !splitFits(hostWidth ?? Infinity) ? "" : undefined} style={{ "--split-min-width": `${SPLIT_MIN_PANE * 2 + SPLIT_GAP}px` } as CSSProperties} ref={hostRef} />
      <DiffContextMenu host={hostRef} lspView={() => handleRef.current?.lspView ?? null} workspaceId={workspaceId} />
    </>
  );
}

function mountInlineDiff(parent: HTMLElement, { agentId, path, original, text, hooks, collapse, wrap, lsp }: { agentId: string; path: string; original: string; text: string; hooks: DiffHooks; collapse: boolean; wrap: boolean; lsp: DiffLspTarget | null }): DiffHandle {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        diffCodeExtensions(path, wrap, { agentId, path, diff: inlineDiffSource }, lsp),
        unifiedMergeView({ original, mergeControls: false, collapseUnchanged: collapse ? COLLAPSE_UNCHANGED : undefined, diffConfig: DIFF_CONFIG }),
        EditorView.updateListener.of((update) => {
          hooks.onPosition?.(chunkPosition(update.state));
          if (update.docChanged && !isMirroredUpdate(update)) hooks.onText(update.state.doc.toString(), update.transactions.some((tr) => tr.isUserEvent("revert")));
          const nextOriginal = getOriginalDoc(update.state).toString();
          hooks.onOriginal(nextOriginal);
          hooks.onResolved(getChunks(update.state)?.chunks.length === 0);
        }),
      ],
    }),
  });
  hooks.onResolved(getChunks(view.state)?.chunks.length === 0);
  hooks.onPosition?.(chunkPosition(view.state));
  const unbind = lsp ? bindDiffView(lsp, view) : null;
  const uncontrol = inlineChunkControls(view);
  return {
    text: () => view.state.doc.toString(),
    measure: () => view.requestMeasure(),
    step: (direction) => stepChunk(view, direction),
    reveal: (line) => revealLine(view, line),
    lspView: lsp ? view : null,
    destroy: () => {
      uncontrol();
      unbind?.();
      view.destroy();
    },
  };
}

export function relabelCollapsed(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>(".cm-collapsedLines")) {
    const m = /(\d+) unchanged lines/.exec(el.textContent ?? "");
    if (!m) continue;
    const inner = document.createElement("span");
    inner.className = "cm-collapsed-inner";
    const icon = document.createElement("span");
    icon.className = "codicon codicon-unfold";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = S.hiddenLines(Number(m[1]));
    inner.append(icon, label);
    el.replaceChildren(inner);
  }
}

export function DiffTab({ tabKey, agentId, workspaceId, path, changeScope, active }: { tabKey: string; agentId: string; workspaceId: string; path: string; changeScope?: ChangeScope; active: boolean }) {
  const { loaded, original, kept, error, retry } = useOriginal(agentId, path, changeScope);
  const [resolved, setResolved] = useState(false);
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const outside = useStore((s) => {
    const cwd = s.agents.find((a) => a.id === agentId)?.cwd;
    return !!cwd && !path.startsWith(`${cwd}/`);
  });
  const hasGitBase = useStore((s) => !!s.gitInfo[agentId]?.repoRoot && !!s.gitInfo[agentId]?.hasHead);
  const relative = workspace && path.startsWith(`${workspace.dir}/`) ? path.slice(workspace.dir.length + 1) : path;
  const scope = `tab:${agentId}:${path}`;
  const narrow = useSplitNarrow(`${scope}|`);
  const handle = useRef<DiffHandle | null>(null);
  const [position, setPosition] = useState<ChunkPosition>({ index: 0, count: 0 });
  const changed = useStore((s) => s.gitChanges[agentId]?.files.find((f) => f.path === path));
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const onRevision = (event: Event) => {
      const detail = (event as CustomEvent<{ agentId: string; path: string }>).detail;
      if (detail.agentId === agentId && detail.path === path) setRevision((n) => n + 1);
    };
    window.addEventListener(FILE_REVISION_EVENT, onRevision);
    return () => window.removeEventListener(FILE_REVISION_EVENT, onRevision);
  }, [agentId, path]);
  useEffect(() => registerDiffNav(tabKey, { step: (direction) => handle.current?.step(direction), openFile: () => openFile({ workspaceId, path: relative }) }), [tabKey, workspaceId, relative]);
  return (
    <div className="editor diff-tab-editor" style={{ display: active ? "flex" : "none" }}>
      <DiffCrumbs tabKey={tabKey} workspaceId={workspaceId} path={relative}>
        {original === null && loaded && <span className="faint xs">{S.newFile}</span>}
        {kept && hasGitBase && <span className="faint xs">{S.keptBaseline}</span>}
        {resolved && <span className="faint xs">{S.noDifferences}</span>}
        {narrow && <span className="faint xs">{S.splitNeedsWidth}</span>}
      </DiffCrumbs>
      {error ? <BaseLoadFailed message={error} onRetry={retry} /> : loaded ? <FileDiff key={`${agentId}:${path}:${changeScope ?? ""}:${revision}`} agentId={agentId} workspaceId={workspaceId} path={path} original={original} scope={scope} onResolved={setResolved} readOnly={outside} handleRef={handle} onPosition={(next) => setPosition((prev) => (prev.index === next.index && prev.count === next.count ? prev : next))} /> : <div className="empty-hint">{S.loadingBase}</div>}
      {!outside && loaded && !resolved && position.count > 0 && <DiffFileBar agentId={agentId} workspaceId={workspaceId} file={changed} path={path} position={position} onStep={(direction) => handle.current?.step(direction)} />}
    </div>
  );
}

function DiffFileBar({ agentId, workspaceId, file, path, position, onStep }: { agentId: string; workspaceId: string; file: ChangedFile | undefined; path: string; position: ChunkPosition; onStep: (direction: 1 | -1) => void }) {
  return (
    <div className="diff-file-bar" role="toolbar" aria-label={S.diffFileBarAria}>
      <button type="button" className="chunk-hover-button" data-primary="" title={S.keepFileTitle} onClick={() => void keepChangedFile(agentId, workspaceId, path).catch((e: Error) => flash(e.message))}>
        {S.keep}
      </button>
      {file && file.status !== "R" && (
        <button type="button" className="chunk-hover-button" title={S.discardChanges} onClick={() => void discardChangedFile(agentId, path, file.rel).catch((e: Error) => flash(S.discardFailed(e.message), "error"))}>
          {S.undo}
        </button>
      )}
      <span className="diff-file-bar-sep" aria-hidden="true" />
      <span className="diff-file-bar-count">{S.changeOf(position.index, position.count)}</span>
      <Button size="icon" aria-label={S.previousChange} title={S.previousChange} onClick={() => onStep(-1)}>
        <Codicon name="arrow-up" />
      </Button>
      <Button size="icon" aria-label={S.nextChange} title={S.nextChange} onClick={() => onStep(1)}>
        <Codicon name="arrow-down" />
      </Button>
    </div>
  );
}

export function DiffCrumbs({ tabKey, workspaceId, path, children }: { tabKey: string; workspaceId: string; path: string; children?: ReactNode }) {
  return (
    <div className="diff-crumbs">
      <FileTypeIcon name={path} />
      <Breadcrumbs tabKey={tabKey} workspaceId={workspaceId} path={path} deleted={false} />
      <span className="spacer" />
      {children}
    </div>
  );
}
