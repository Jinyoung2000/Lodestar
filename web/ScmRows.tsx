import { useMemo, useState } from "react";
import { buildScmTree, scmBasename, scmDirname, scmEntriesUnder, type ScmCode, type ScmEntry, type ScmTreeNode } from "../shared/scm";
import { FileTypeIcon, FolderTypeIcon } from "./FileTypeIcon";
import { ChevronRight, Codicon } from "./icons";
import type { ScmActions } from "./scmActions";
import { toggleScmSection, useScmView, type ScmSection } from "./scmState";
import { M } from "./scmStrings";

export type GroupKind = "merge" | "staged" | "changes";

const GROUP_TITLE: Record<GroupKind, string> = { merge: M.mergeChanges, staged: M.stagedChanges, changes: M.changes };

// 변경 묶음 하나(Merge Changes, Staged Changes, Changes). 머리에는 개수와 마우스를 올리면 보이는 묶음 단추, 아래에 목록 또는 폴더 트리가 온다.
export function ScmGroup({ kind, entries, tree, actions }: { kind: GroupKind; entries: ScmEntry[]; tree: boolean; actions: ScmActions }) {
  const collapsed = useScmView((v) => !!v.collapsed[kind as ScmSection]);
  return (
    <section className="scm-group" data-kind={kind} aria-label={GROUP_TITLE[kind]}>
      <div className="scm-section-head">
        <button type="button" className="scm-section-toggle" aria-expanded={!collapsed} onClick={() => toggleScmSection(kind)}>
          <span className="scm-chev" data-collapsed={collapsed || undefined}>
            <ChevronRight />
          </span>
          <span className="scm-section-title">{GROUP_TITLE[kind]}</span>
        </button>
        <span className="scm-head-actions">
          {kind === "changes" && <ActionButton label={M.discardAll} icon="discard" onClick={() => void actions.discard(entries, GROUP_TITLE.changes)} />}
          {kind === "changes" && <ActionButton label={M.stageAll} icon="add" onClick={() => void actions.stage(entries)} />}
          {kind === "staged" && <ActionButton label={M.unstageAll} icon="remove" onClick={() => void actions.unstage(entries)} />}
          {kind === "merge" && <ActionButton label={M.stageAllMerge} icon="add" onClick={() => void actions.stage(entries)} />}
        </span>
        <span className="scm-count" aria-label={`${entries.length}`}>
          {entries.length}
        </span>
      </div>
      {!collapsed && (tree ? <EntryTree kind={kind} entries={entries} actions={actions} /> : entries.map((entry) => <FileRow key={entry.rel} kind={kind} entry={entry} depth={0} tree={false} actions={actions} />))}
    </section>
  );
}

function EntryTree({ kind, entries, actions }: { kind: GroupKind; entries: ScmEntry[]; actions: ScmActions }) {
  const nodes = useMemo(() => buildScmTree(entries), [entries]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return (
    <>
      {nodes.map((node) => (
        <TreeNode key={node.path} node={node} kind={kind} depth={0} closed={closed} onToggle={toggle} actions={actions} />
      ))}
    </>
  );
}

function TreeNode({ node, kind, depth, closed, onToggle, actions }: { node: ScmTreeNode; kind: GroupKind; depth: number; closed: Set<string>; onToggle: (path: string) => void; actions: ScmActions }) {
  if (node.entry) return <FileRow kind={kind} entry={node.entry} depth={depth} tree actions={actions} name={node.name} />;
  const files = scmEntriesUnder(node);
  const isClosed = closed.has(node.path);
  return (
    <div role="group">
      <div className="scm-row scm-folder" role="treeitem" aria-expanded={!isClosed} tabIndex={0} style={indent(depth)} title={node.path} onClick={() => onToggle(node.path)} onKeyDown={(e) => e.key === "Enter" && onToggle(node.path)}>
        <span className="scm-chev" data-collapsed={isClosed || undefined}>
          <ChevronRight />
        </span>
        <FolderTypeIcon name={node.name.slice(node.name.lastIndexOf("/") + 1)} open={!isClosed} />
        <span className="scm-name">{node.name}</span>
        <span className="scm-row-actions">
          {kind === "changes" && <ActionButton label={M.discardFolder} icon="discard" onClick={() => void actions.discard(files, node.path)} />}
          {kind === "staged" ? <ActionButton label={M.unstageFolder} icon="remove" onClick={() => void actions.unstage(files)} /> : <ActionButton label={M.stageFolder} icon="add" onClick={() => void actions.stage(files)} />}
        </span>
        <span className="scm-status" data-s={dominant(files)} aria-hidden="true">
          <Codicon name="circle-small-filled" />
        </span>
      </div>
      {!isClosed && node.children.map((child) => <TreeNode key={child.path} node={child} kind={kind} depth={depth + 1} closed={closed} onToggle={onToggle} actions={actions} />)}
    </div>
  );
}

// 목록 보기의 행: 아이콘, 이름, 상위 폴더, (마우스를 올리면) 단추, 오른쪽 끝 상태 글자. 트리 보기는 폴더 아래에서 들여 쓰고 이름만 보인다.
function FileRow({ kind, entry, depth, tree, actions, name }: { kind: GroupKind; entry: ScmEntry; depth: number; tree: boolean; actions: ScmActions; name?: string }) {
  const shown = name ?? scmBasename(entry.rel);
  const dir = tree ? "" : scmDirname(entry.rel);
  // ⌥클릭, ⌥⌘클릭은 옆 그룹에 연다
  const open = (side = false) => actions.openChanges(entry, kind, side);
  return (
    <div
      className="scm-row scm-file"
      role="treeitem"
      tabIndex={0}
      data-s={entry.code}
      style={tree ? indent(depth) : undefined}
      title={`${entry.rel}${entry.from ? ` (${M.renamedFrom(entry.from)})` : ""} - ${M.statusName[entry.code]}`}
      onClick={(e) => open(e.altKey)}
      onKeyDown={(e) => e.key === "Enter" && open(e.ctrlKey || e.metaKey)}
    >
      {tree && <span className="scm-chev-gap" />}
      <FileTypeIcon name={shown} />
      <span className="scm-name">{shown}</span>
      {dir && <span className="scm-dir">{dir}</span>}
      <span className="scm-row-actions">
        <ActionButton label={M.openFile} icon="go-to-file" onClick={() => actions.openEntry(entry)} />
        {kind === "changes" && <ActionButton label={M.discard} icon="discard" onClick={() => void actions.discard([entry])} />}
        {kind === "staged" ? <ActionButton label={M.unstage} icon="remove" onClick={() => void actions.unstage([entry])} /> : <ActionButton label={M.stage} icon="add" onClick={() => void actions.stage([entry])} />}
      </span>
      <span className="scm-status" data-s={entry.code} title={M.statusName[entry.code]}>
        {entry.code}
      </span>
    </div>
  );
}

export function ActionButton({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="scm-action"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Codicon name={icon} />
    </button>
  );
}

const indent = (depth: number) => ({ paddingLeft: `calc(var(--space-3) + ${depth} * var(--space-3))` });

const PRIORITY: ScmCode[] = ["!", "D", "M", "R", "T", "C", "A", "U"];

// 폴더 점의 색: 아래 파일들 가운데 가장 눈에 띄는 상태
function dominant(entries: ScmEntry[]): ScmCode {
  return PRIORITY.find((code) => entries.some((e) => e.code === code)) ?? "M";
}
