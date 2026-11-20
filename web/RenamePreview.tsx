import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { fileState, selectedEdit, visibleBreaks, type PreviewEdit, type PreviewFile, type WorkspaceEdit } from "./renameModel";
import "./RenamePreview.css";

export const PREVIEW_TEXT = { title: "Refactor Preview", apply: "Apply Refactoring", discard: "Discard Refactoring" };

type Props = {
  files: PreviewFile[];
  label: string;
  names: ReadonlyMap<string, string>;
  bounds: { left: number; width: number; bottom: number; height: number };
  onApply: (edit: WorkspaceEdit) => void;
  onDiscard: () => void;
};

export function RenamePreview({ files, label, names, bounds, onApply, onDiscard }: Props) {
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const applyRef = useRef<HTMLButtonElement>(null);
  const total = files.reduce((sum, file) => sum + file.edits.length, 0);
  const checked = total - unchecked.size;
  useEffect(() => {
    applyRef.current?.focus();
  }, []);

  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(unchecked);
    for (const id of ids) {
      if (on) next.delete(id);
      else next.add(id);
    }
    setUnchecked(next);
  };
  const apply = () => {
    if (checked > 0) onApply(selectedEdit(files, unchecked));
  };

  return (
    <div
      className="rename-preview"
      role="dialog"
      aria-label={PREVIEW_TEXT.title}
      data-testid="rename-preview"
      style={{ left: bounds.left, width: bounds.width, bottom: window.innerHeight - bounds.bottom, height: bounds.height }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onDiscard();
        } else if (event.key === "Enter" && event.metaKey) {
          event.preventDefault();
          apply();
        }
      }}
    >
      <div className="rename-preview-head">
        <span className="rename-preview-title">{PREVIEW_TEXT.title}</span>
        <span className="rename-preview-label">{label}</span>
      </div>
      <div className="rename-preview-list" role="tree">
        {files.map((file) => (
          <FileGroup key={file.uri} file={file} name={names.get(file.uri) ?? file.uri} unchecked={unchecked} onToggle={toggle} />
        ))}
      </div>
      <div className="rename-preview-buttons">
        <button ref={applyRef} type="button" className="rename-preview-button" data-primary="" disabled={checked === 0} onClick={apply}>
          {PREVIEW_TEXT.apply}
        </button>
        <button type="button" className="rename-preview-button" onClick={onDiscard}>
          {PREVIEW_TEXT.discard}
        </button>
      </div>
    </div>
  );
}

function FileGroup({ file, name, unchecked, onToggle }: { file: PreviewFile; name: string; unchecked: ReadonlySet<string>; onToggle: (ids: string[], on: boolean) => void }) {
  const boxRef = useRef<HTMLInputElement>(null);
  const state = fileState(file, unchecked);
  useEffect(() => {
    if (boxRef.current) boxRef.current.indeterminate = state === "some";
  }, [state]);
  const slash = name.lastIndexOf("/");
  const base = name.slice(slash + 1);
  const folder = slash >= 0 ? name.slice(0, slash) : "";
  return (
    <div role="group">
      <label className="rename-preview-row" data-kind="file" role="treeitem" aria-level={1}>
        <input ref={boxRef} type="checkbox" checked={state === "all"} onChange={() => onToggle(file.edits.map((item) => item.id), state !== "all")} />
        <span className="rename-preview-file">{base}</span>
        <span className="rename-preview-folder">{folder}</span>
      </label>
      {file.edits.map((item) => (
        <EditRow key={item.id} item={item} checked={!unchecked.has(item.id)} onToggle={onToggle} />
      ))}
    </div>
  );
}

function EditRow({ item, checked, onToggle }: { item: PreviewEdit; checked: boolean; onToggle: (ids: string[], on: boolean) => void }) {
  return (
    <label className="rename-preview-row" data-kind="edit" role="treeitem" aria-level={2}>
      <input type="checkbox" checked={checked} onChange={() => onToggle([item.id], !checked)} />
      <span className="rename-preview-text">
        <span>{visibleBreaks(item.prefix)}</span>
        {item.removed && <span className="rename-preview-remove">{visibleBreaks(item.removed)}</span>}
        {item.inserted && <span className="rename-preview-insert">{visibleBreaks(item.inserted)}</span>}
        <span>{visibleBreaks(item.suffix)}</span>
      </span>
    </label>
  );
}

// 패널을 body 에 붙이고 사용자가 고르기를 기다린다. 적용하면 체크된 항목만 든 편집을, 버리면 null 을 돌려준다.
export function openRenamePreview(options: { files: PreviewFile[]; label: string; names: ReadonlyMap<string, string>; bounds: { left: number; width: number; bottom: number; height: number } }): Promise<WorkspaceEdit | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const finish = (result: WorkspaceEdit | null) => {
      root.unmount();
      host.remove();
      resolve(result);
    };
    const height = Math.min(options.bounds.height, Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--size-preview-panel")) || options.bounds.height);
    root.render(<RenamePreview {...options} bounds={{ ...options.bounds, height }} onApply={finish} onDiscard={() => finish(null)} />);
  });
}
