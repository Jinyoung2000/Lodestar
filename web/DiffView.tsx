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

// CodeMirror 문서의 글은 줄바꿈이 늘 "\n" 이다. CRLF 파일에 그대로 쓰면 파일 전체의 줄끝이 바뀌므로 원래 줄끝으로 되돌려 쓴다.
const eolOf = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n");
const withEol = (text: string, eol: "\n" | "\r\n") => (eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text);
const sameLines = (a: string, b: string) => a === b || a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n");

// 파일 하나의 기준 내용. "유지"로 앞당긴 기준이 있으면 그것, 없으면 변경 범위(scope)의 git 기준.
// scope 를 안 주면 세션의 기본 범위(worktree 는 merge-base, 아니면 세션 시작 커밋)다. 기본이 아닌 범위(Uncommitted, Last Turn 등)는 "유지" 기록을 쓰지 않는다.
// enabled 가 false 면 기준을 묻지 않는다(Changes 카드 보기에서 화면 밖 카드가 375개씩 한꺼번에 묻지 않게).
export function useOriginal(agentId: string, path: string, scope?: ChangeScope, file?: Pick<ChangedFile, "status" | "from">, enabled = true) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  // "유지"한 기준은 세션이 바꾼 파일을 보는 Branch 와 Session 범위에 적용한다(Branch 가 처음 범위라 여기서 유지가 보여야 한다). Uncommitted 와 Last Turn 은 자기 기준이 따로 있다.
  const keptApplies = !scope || !agent || scope === defaultChangeScope(agent) || scope === "branch" || scope === "session";
  const kept = useStore((s) => (keptApplies ? s.changes[agentId]?.find((c) => c.path === path) : undefined));
  const [gitOriginal, setGitOriginal] = useState<{ path: string; scope: ChangeScope | undefined; text: string | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // 추가된 파일(A)은 기준에 없는 파일이라 물어볼 것이 없다
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

// 기준을 읽지 못한 카드와 탭이 로딩에서 멈추지 않고 이유와 다시 시도를 보인다.
export function BaseLoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="diff-empty diff-load-failed" role="alert">
      <span title={message}>{S.baseLoadFailed}</span>
      <Button onClick={onRetry}>{S.retry}</Button>
    </div>
  );
}

// scope 는 헤더의 "Split needs more width" 표시가 어느 diff 들을 보는지 가르는 이름이다 (같은 패널의 diff 끼리 같은 scope).
// collapse 는 바뀌지 않은 줄을 접어 둘지(기본 켬). 카드 머리의 Collapse Unchanged Regions 가 끈다.
type Props = { agentId: string; workspaceId: string; path: string; original: string | null; scope: string; onResolved?: (resolved: boolean) => void; collapse?: boolean; wrap?: boolean; readOnly?: boolean; handleRef?: MutableRefObject<DiffHandle | null>; onPosition?: (position: ChunkPosition) => void };

// 파일 diff. 보기는 Inline(한 열, unified)과 Split(기준 왼쪽, 현재 오른쪽) 둘이고, 덩어리의 "유지"는 기준을 그 덩어리만큼 앞으로 옮기고(데몬에 저장),
// "되돌리기"는 파일을 그 덩어리만큼 수정 전으로 되돌려 디스크에 쓴다. 두 보기가 같은 hooks 를 거치므로 결과가 같다.
export function FileDiff({ agentId, workspaceId, path, original, scope, onResolved, collapse = true, wrap = false, readOnly = false, handleRef: sharedHandle, onPosition }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ownHandle = useRef<DiffHandle | null>(null);
  const handleRef = sharedHandle ?? ownHandle;
  // 기준은 처음 열 때 값으로 시작하고, 이후엔 에디터 안의 "유지" 로만 바뀐다. 보기를 바꿔 다시 만들 때도 이 값을 쓴다.
  const originalRef = useRef(original ?? "");
  // original 이 null 이면 기준에 이 파일이 없다(에이전트가 새로 만든 파일). Keep 으로 기준에 내용이 생기면 더는 아니다.
  const baseMissing = useRef(original === null);
  // 마지막으로 아는 현재 본문. 보기를 바꿀 때 디스크를 다시 읽지 않고 이 값으로 이어 간다 (쓰기 대기 중인 Undo 가 사라지지 않게).
  const textRef = useRef<{ key: string; text: string; exists: boolean } | null>(null);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 150ms 뒤에 디스크에 쓸 Undo 가 대기 중인지. 쓰기가 끝날 때까지 true 다(writeTimer 는 타이머가 돌면 null 이 되고, 취소만 하면 값이 남는다).
  const writePending = useRef(false);
  // 이 diff 를 만들 때 읽은(또는 마지막으로 쓴) 디스크 글. Undo 를 쓰기 전에 디스크가 그 사이 바뀌었으면 쓰지 않는다(에이전트나 다른 편집기의 수정을 옛 글로 덮지 않게).
  const diskRef = useRef<{ key: string; text: string | null } | null>(null);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  // 현재 쪽 파일의 줄끝. CodeMirror 는 문서를 늘 "\n" 으로 이어 돌려주므로 CRLF 파일에 쓸 때 되돌린다.
  const eolRef = useRef<"\n" | "\r\n">("\n");
  const [error, setError] = useState<string | null>(null);
  // 에이전트가 같은 파일을 또 고치면 뷰를 통째로 다시 만든다. 본문만 바꿔 넣으면 접힌 줄(collapseUnchanged)이 다시 안 접힌다.
  const [reload, setReload] = useState(0);
  const [requested] = useDiffView();
  const [hostWidth, setHostWidth] = useState<number | null>(null);
  const instance = useId();
  // DIFFFB: 칩이나 목록에서 이 파일의 피드백 위치로 오라는 요청. 보기를 다시 만들 때마다 같은 요청을 다시 따르지 않게 처리한 번호를 기억한다.
  const reveal = useFeedbackReveal();
  const revealed = useRef(0);
  const [mounts, setMounts] = useState(0);
  const autoInline = useDefaults().diffInlineWhenNarrow;
  const { mode, tooNarrow } = chooseDiffMode(requested, hostWidth, autoInline);
  const measured = hostWidth !== null;

  // 폭 재기. 숨겨진 탭은 폭이 0 이라 무시한다 (다시 보일 때 같은 폭으로 돌아오므로 보기가 다시 만들어지지 않는다).
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

  // 쓰기 대기 중인 Undo 는 보기만 바꿀 때는 살려 두고, 이 칸이 사라질 때만 버린다.
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

    // 쓰기 직전에 디스크를 다시 읽어 이 diff 를 만들 때의 글과 같을 때만 쓴다. 다르면 쓰지 않고 디스크 내용으로 다시 만든다. 쓰기는 하나씩 차례로 한다.
    const writeDisk = (next: string | null, after: () => Promise<unknown>) => {
      writeQueue.current = writeQueue.current
        .then(async () => {
          // 그 사이 diff 가 디스크 내용으로 다시 만들어졌으면(diskKey 가 다름) 이 Undo 는 옛 화면에서 한 것이라 쓰지 않는다
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
          // 다음 Undo 가 이미 기다리고 있으면 대기 표시를 남긴다
          if (writeTimer.current === null) writePending.current = false;
        });
    };

    const hooks: DiffHooks = {
      onText: (docText, reverted) => {
        const text = withEol(docText, eolRef.current);
        textRef.current = { key: diskKey, text, exists: textRef.current?.exists ?? true };
        if (writeTimer.current) clearTimeout(writeTimer.current);
        // 새 파일이 전부 되돌려지면 0바이트로 남기지 않고 휴지통으로 보낸다. 변경 기록도 같이 지워 목록에서 빠진다.
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
        // inline 보기는 갱신마다 기준 글을 알린다. 줄끝만 다른 같은 글은 바뀐 것이 아니다(CRLF 기준을 LF 로 덮어 저장하지 않게).
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
        // 수정본 쪽은 디스크의 작업 파일이라 일반 에디터와 같은 LSP 를 붙인다. 같은 파일의 탭에 저장 안 한 편집이 있으면 그 글로 시작해 서버가 가진 글과 같게 한다.
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
        // 에이전트의 새 수정이 이기도록, 아직 못 쓴 Undo 는 버리고 디스크 내용으로 다시 만든다.
        if (writeTimer.current) clearTimeout(writeTimer.current);
        writePending.current = false;
        setReload((n) => n + 1);
      });
    });
    // FIX6B: 바깥에서 파일이 바뀌면(git merge --abort, checkout, 다른 편집기) 데몬의 파일 감시가 알린다. 디스크가 지금 diff 와 다르면 도구 완료 때와 똑같이 다시 만든다.
    const offWorkspace = onWorkspaceChanged(workspaceId, () => {
      void rpc.call("files.read", { workspaceId, path }).then(({ text }) => {
        const current = handleRef.current;
        if (disposed || !current || text === null || sameLines(current.text(), initialModifiedText(diffLspTarget(workspaceId, path, true), text))) return;
        // 아직 디스크에 못 쓴 Undo 가 있으면 그 쓰기가 끝난 뒤의 알림에서 다시 비교한다
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
    // 이 칸이 한참 뒤에 만들어졌다면 옛 요청이다
    if (Date.now() - reveal.at > REVEAL_FRESH_MS) return;
    revealed.current = reveal.nonce;
    handleRef.current.reveal(reveal.line);
  }, [reveal, mounts, agentId, path]);

  // 코드 글꼴 설정이 바뀌면 글자 크기와 줄 높이를 다시 잰다.
  useEffect(() => subscribeEditorFont(() => handleRef.current?.measure()), []);

  if (error) return <div className="editor-error">{error}</div>;
  return (
    <>
      <div className="editor-host file-diff-host" data-mode={mode} data-readonly={readOnly ? "" : undefined} data-scroll-x={mode === "split" && !splitFits(hostWidth ?? Infinity) ? "" : undefined} style={{ "--split-min-width": `${SPLIT_MIN_PANE * 2 + SPLIT_GAP}px` } as CSSProperties} ref={hostRef} />
      <DiffContextMenu host={hostRef} lspView={() => handleRef.current?.lspView ?? null} workspaceId={workspaceId} />
    </>
  );
}

// unified diff 한 열. 덩어리 버튼은 deleted 덩어리 위젯 안에 라이브러리가 그린다.
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

// "N unchanged lines" 를 "N hidden lines" 로. 라이브러리는 phrase 를 바꿀 길이 없어 DOM 에서 바꾼다.
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
  // 세션의 작업 폴더 밖 파일(모노레포의 다른 폴더)은 보기만 된다
  const outside = useStore((s) => {
    const cwd = s.agents.find((a) => a.id === agentId)?.cwd;
    return !!cwd && !path.startsWith(`${cwd}/`);
  });
  // 기준 커밋이 없는 세션에서는 기록된 기준이 곧 수정 전 스냅샷이라 "유지한 기준" 표시가 맞지 않는다.
  const hasGitBase = useStore((s) => !!s.gitInfo[agentId]?.repoRoot && !!s.gitInfo[agentId]?.hasHead);
  const relative = workspace && path.startsWith(`${workspace.dir}/`) ? path.slice(workspace.dir.length + 1) : path;
  const scope = `tab:${agentId}:${path}`;
  const narrow = useSplitNarrow(`${scope}|`);
  const handle = useRef<DiffHandle | null>(null);
  const [position, setPosition] = useState<ChunkPosition>({ index: 0, count: 0 });
  const changed = useStore((s) => s.gitChanges[agentId]?.files.find((f) => f.path === path));
  // 변경 목록 행의 Keep 처럼 밖에서 이 파일의 기준을 바꾸면 diff 를 새 기준으로 다시 만든다. 옛 기준으로 남은 diff 에서 덩어리를 Keep 하면 바뀐 기준을 옛 기준으로 되돌려 저장한다.
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
