import { useId, useMemo, useState } from "react";
import type { PrFile, PrThread } from "../shared/prTypes";
import { isGeneratedPath } from "../shared/generatedFiles";
import { DiffViewToggle } from "./DiffViewToggle";
import { PrDiff } from "./PrDiff";
import { PrLspChip, PrReferencesPanel } from "./PrCodeLsp";
import { usePrLsp } from "./usePrLsp";
import { ChevronRight, Codicon } from "./icons";
import { FileTypeIcon, FolderTypeIcon } from "./FileTypeIcon";
import { refKey, setFilesListWidth, usePr, usePrActions, usePrView, type PrActions } from "./prStore";
import { P } from "./prStrings";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Resizer } from "./Resizer";
import { S } from "./strings";

const LIST_MIN = 200; // --size-changes-list-min
const DIFF_MIN = 360; // --size-changes-diff-min

// Files Changed: 왼쪽에 고른 파일의 diff, 오른쪽에 파일 목록(기본은 폴더 트리, 목록으로 바꿀 수 있다). Changes 패널처럼 코드가 먼저 보이고 목록이 옆에 붙는다.
// 트리는 Files 탭(탐색기)과 같은 행(tree-node, 접히는 폴더, 파일 종류 아이콘, 상태 글자색)이다.
// 목록 왼쪽 경계를 끌어 폭을 바꾸고(더블클릭은 기본 폭), 끈 폭은 모든 PR 화면이 같이 쓴다.
export function PrFiles() {
  const allFiles = usePrView((v) => v.files);
  // 생성 파일(__generated__, *.graphql.ts)은 목록과 diff 에서 뺀다(shared/generatedFiles.ts)
  const files = useMemo(() => allFiles?.filter((f) => !isGeneratedPath(f.path)) ?? null, [allFiles]);
  const error = usePrView((v) => v.filesError);
  // 고른 파일이 목록에 없으면(처음, 또는 새로 읽은 목록에서 사라짐) 첫 파일
  const selectedFile = usePrView((v) => v.selectedFile);
  const selected = files?.some((f) => f.path === selectedFile) ? selectedFile : (files?.[0]?.path ?? null);
  const threads = usePrView((v) => v.detail?.threads);
  const actions = usePrActions();
  const [tree, setTree] = useState(true);
  const listWidth = usePr((s) => s.filesListWidth);
  const listId = useId();
  const file = files?.find((f) => f.path === selected) ?? null;
  const repo = usePrView((v) => v.ref?.repo ?? "");
  // 다른 PR 로 바뀌면 diff 의 줄 선택과 새 코멘트 입력창을 새로 시작한다(같은 경로의 파일이어도 앞 PR 의 줄 자리로 코멘트가 가지 않게)
  const prKey = usePrView((v) => (v.ref ? refKey(v.ref) : ""));
  // 코드 보기(hover, 정의 이동). 파일 diff 가 화면에 보일 때만 그 파일의 문서를 LSP 에 연다.
  const [diffHost, setDiffHost] = useState<HTMLElement | null>(null);
  const lsp = usePrLsp(file, diffHost);
  const byPath = useMemo(() => {
    const map = new Map<string, PrThread[]>();
    for (const thread of threads ?? []) map.set(thread.path, [...(map.get(thread.path) ?? []), thread]);
    return map;
  }, [threads]);

  if (!files) return <div className="pr-empty">{error ?? P.loading}</div>;
  return (
    <div className="pr-files" data-pr-files={listId} key={prKey}>
      <div className="pr-files-diff">
        {file ? (
          <>
            <div className="pr-file-head">
              <span className="pr-file-path" title={file.path}>
                {file.path}
              </span>
              <span className="pr-stat" data-kind="add">
                +{file.additions}
              </span>
              <span className="pr-stat" data-kind="del">
                -{file.deletions}
              </span>
              <span className="spacer" />
              <PrLspChip status={lsp.status} mismatched={lsp.mismatched} repo={repo} />
              <DiffViewToggle narrow={false} />
              <label className="pr-viewed">
                <Checkbox checked={file.viewed} aria-label={P.viewed} onCheckedChange={(checked) => void actions.setViewed(file.path, checked === true)} />
                {P.viewed}
              </label>
            </div>
            <div className="pr-diff-scroll" ref={setDiffHost}>
              <PrDiff file={file} threads={byPath.get(file.path) ?? []} lsp={lsp} />
            </div>
            {lsp.refs && <PrReferencesPanel refs={lsp.refs} onClose={lsp.closeReferences} onOpen={(hit) => lsp.doc && lsp.navigate(hit.location, lsp.doc)} />}
          </>
        ) : (
          <div className="pr-empty">{P.selectFile}</div>
        )}
      </div>
      {/* 가운데 PR 화면과 옆 칸 PR 탭이 같이 떠 있을 수 있어 자기 목록만 집도록 data 값으로 대상을 고른다 */}
      <Resizer axis="x" label={S.resizeFileList} target={`[data-pr-files="${listId}"] > .pr-files-list`} direction={-1} min={LIST_MIN} max={() => listMax(listId)} onSize={setFilesListWidth} />
      <div className="pr-files-list" style={listWidth !== null ? { flexBasis: listWidth } : undefined}>
        <div className="pr-files-head">
          <span>{P.files(files.length)}</span>
          <span className="spacer" />
          <Button size="icon" variant={tree ? "ghost-on" : "ghost"} aria-label="View as Tree" aria-pressed={tree} title="View as Tree" onClick={() => setTree((v) => !v)}>
            <Codicon name="list-tree" size={14} />
          </Button>
        </div>
        <div className="pr-files-scroll" role="list">
          {tree ? <TreeRows files={files} selected={selected} byPath={byPath} actions={actions} /> : files.map((f) => <FileRow key={f.path} file={f} depth={0} label={null} selected={selected === f.path} comments={countComments(byPath.get(f.path))} actions={actions} />)}
        </div>
      </div>
    </div>
  );
}

// 끌 수 있는 최대 폭: diff 열이 DIFF_MIN 아래로 눌리지 않을 만큼
function listMax(listId: string) {
  const width = document.querySelector(`[data-pr-files="${listId}"]`)?.getBoundingClientRect().width ?? 0;
  return Math.max(LIST_MIN, width - DIFF_MIN);
}

const countComments =(threads: PrThread[] | undefined) => threads?.reduce((n, t) => n + t.comments.length, 0) ?? 0;

const STATUS_LETTER: Record<PrFile["status"], string> = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M", unchanged: "M" };

function FileRow({ file, depth, label, selected, comments, actions }: { file: PrFile; depth: number; label: string | null; selected: boolean; comments: number; actions: PrActions }) {
  const slash = file.path.lastIndexOf("/");
  const name = label ?? file.path.slice(slash + 1);
  const dir = label === null && slash >= 0 ? file.path.slice(0, slash) : "";
  return (
    <div className="pr-file-row list-row" role="listitem" data-active={selected || undefined} data-viewed={file.viewed || undefined} style={depth ? { paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-3))` } : undefined}>
      <Checkbox checked={file.viewed} aria-label={`${P.viewed}: ${file.path}`} onCheckedChange={(checked) => void actions.setViewed(file.path, checked === true)} />
      <button type="button" className="pr-file-main" title={file.path} onClick={() => actions.selectFile(file.path)}>
        <span className="pr-file-name">{name}</span>
        {dir && <span className="pr-file-dir">{dir}</span>}
        {comments > 0 && (
          <span className="pr-file-comments" title={`${comments} comments`}>
            <Codicon name="comment" size={12} />
            {comments}
          </span>
        )}
        <span className="pr-file-status" data-s={STATUS_LETTER[file.status]}>
          {STATUS_LETTER[file.status]}
        </span>
      </button>
    </div>
  );
}

type Node = { name: string; path: string; file: PrFile | null; children: Node[] };

function buildTree(files: PrFile[]): Node[] {
  const root: Node = { name: "", path: "", file: null, children: [] };
  for (const file of files) {
    let at = root;
    const parts = file.path.split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let next = at.children.find((c) => c.name === part && (i === parts.length - 1) === (c.file !== null));
      if (!next) {
        next = { name: part, path, file: i === parts.length - 1 ? file : null, children: [] };
        at.children.push(next);
      }
      at = next;
    });
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => Number(a.file !== null) - Number(b.file !== null) || a.name.localeCompare(b.name));
    for (const node of nodes) sort(node.children);
  };
  sort(root.children);
  return root.children;
}

// 폴더 트리. Files 탭(web/FilesTab.tsx TreeRow)과 같은 행: 폴더는 눌러 접고 펴는 화살표와 폴더 아이콘, 파일은 화살표 자리를 비우고 파일 종류 아이콘을 둔다.
function TreeRows({ files, selected, byPath, actions }: { files: PrFile[]; selected: string | null; byPath: Map<string, PrThread[]>; actions: PrActions }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const render = (nodes: Node[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      if (node.file) return <TreeFileRow key={node.path} file={node.file} name={node.name} depth={depth} selected={selected === node.path} comments={countComments(byPath.get(node.path))} actions={actions} />;
      const isCollapsed = collapsed.has(node.path);
      return (
        <div key={node.path} role="group">
          <button type="button" className="tree-node" aria-expanded={!isCollapsed} style={treeIndent(depth)} title={node.path} onClick={() => toggle(node.path)}>
            <span className="chev" data-collapsed={isCollapsed || undefined}>
              <ChevronRight size={14} />
            </span>
            <FolderTypeIcon name={node.name} open={!isCollapsed} />
            <span className="name">{node.name}</span>
          </button>
          {!isCollapsed && render(node.children, depth + 1)}
        </div>
      );
    });
  return <>{render(tree, 0)}</>;
}

// 트리의 파일 행. 이름은 탐색기처럼 상태 색(추가 녹색, 수정 노랑, 삭제 빨강)이고, 본 파일은 흐리게, Viewed 체크는 행 끝에 둔다.
function TreeFileRow({ file, name, depth, selected, comments, actions }: { file: PrFile; name: string; depth: number; selected: boolean; comments: number; actions: PrActions }) {
  const status = STATUS_LETTER[file.status];
  return (
    <div
      role="listitem"
      tabIndex={0}
      className="tree-node pr-tree-file"
      data-status={status}
      data-selected={selected || undefined}
      data-viewed={file.viewed || undefined}
      style={treeIndent(depth)}
      title={file.path}
      onClick={() => actions.selectFile(file.path)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        actions.selectFile(file.path);
      }}
    >
      <span className="chev" data-spacer aria-hidden="true">
        <ChevronRight size={14} />
      </span>
      <FileTypeIcon name={name} />
      <span className="name">{name}</span>
      {comments > 0 && (
        <span className="pr-file-comments" title={`${comments} comments`}>
          <Codicon name="comment" size={12} />
          {comments}
        </span>
      )}
      <span className="pr-file-status" data-s={status}>
        {status}
      </span>
      <span className="pr-tree-viewed" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={file.viewed} aria-label={`${P.viewed}: ${file.path}`} onCheckedChange={(checked) => void actions.setViewed(file.path, checked === true)} />
      </span>
    </div>
  );
}

const treeIndent = (depth: number) => ({ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-3))` });
