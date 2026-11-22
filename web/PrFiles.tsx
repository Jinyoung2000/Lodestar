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

const LIST_MIN = 200;
const DIFF_MIN = 360;

export function PrFiles() {
  const allFiles = usePrView((v) => v.files);
  const files = useMemo(() => allFiles?.filter((f) => !isGeneratedPath(f.path)) ?? null, [allFiles]);
  const error = usePrView((v) => v.filesError);
  const selectedFile = usePrView((v) => v.selectedFile);
  const selected = files?.some((f) => f.path === selectedFile) ? selectedFile : (files?.[0]?.path ?? null);
  const threads = usePrView((v) => v.detail?.threads);
  const actions = usePrActions();
  const [tree, setTree] = useState(true);
  const listWidth = usePr((s) => s.filesListWidth);
  const listId = useId();
  const file = files?.find((f) => f.path === selected) ?? null;
  const repo = usePrView((v) => v.ref?.repo ?? "");
  const prKey = usePrView((v) => (v.ref ? refKey(v.ref) : ""));
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
