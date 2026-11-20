import { useSyncExternalStore } from "react";
import { allDiagnostics, diagnosticsVersion, subscribeDiagnostics } from "./diagnosticsStore";
import { Codicon } from "./icons";
import { FileTypeIcon } from "./FileTypeIcon";
import { toTarget, uriToPath } from "./lsp";
import { groupProblems, type ProblemFile, type ProblemSeverity, type ProblemSource } from "./problemsModel";
import { baseKeyOf } from "./editorTabs";
import { fileTabKey, getState, openFile, useStore } from "./store";
import { S } from "./strings";

// FIX6C: 아래 패널의 Problems 탭. 열려 있는 파일의 진단(LSP)을 파일별로 모아 보이고, 누르면 그 줄로 간다.
// 언어 서버는 열린 문서만 진단하므로 목록도 열린 파일 탭의 것만이다.
export function ProblemsPanel() {
  const files = useProblemFiles();
  if (files.length === 0) return <div className="empty-hint">{S.noProblemsOpen}</div>;
  return (
    <div className="problems" role="tree" aria-label={S.problems}>
      {files.map((file) => (
        <ProblemFileGroup key={file.key} file={file} />
      ))}
    </div>
  );
}

// 탭 머리의 개수와 패널이 같은 값을 쓴다.
export function useProblemFiles(): ProblemFile[] {
  useSyncExternalStore(subscribeDiagnostics, diagnosticsVersion);
  const tabs = useStore((s) => s.tabs);
  const open = new Set(tabs.filter((t) => t.kind === "file").map((t) => baseKeyOf(t.key)));
  const sources: ProblemSource[] = [];
  for (const [uri, diagnostics] of allDiagnostics()) {
    if (!uri.startsWith("file:")) continue;
    const first = getState().workspaces[0]?.id;
    if (!first) break;
    const target = toTarget(uriToPath(uri), first);
    if (open.has(fileTabKey(target.workspaceId, target.path))) sources.push({ ...target, diagnostics });
  }
  return groupProblems(sources);
}

function ProblemFileGroup({ file }: { file: ProblemFile }) {
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const dir = slash >= 0 ? file.path.slice(0, slash) : "";
  return (
    <div className="problems-file" role="group" aria-label={file.path}>
      <div className="problems-file-head">
        <FileTypeIcon name={name} size={14} />
        <span className="problems-file-name">{name}</span>
        {dir && <span className="faint problems-file-dir">{dir}</span>}
        <span className="spacer" />
        <span className="problems-count">{file.rows.length}</span>
      </div>
      {file.rows.map((row) => (
        <button key={row.id} type="button" role="treeitem" className="problems-row" data-severity={row.severity} title={S.openToSideAlt} onClick={(e) => openFile({ workspaceId: file.workspaceId, path: file.path, line: row.line, column: row.column }, { preview: !e.altKey, side: e.altKey })}>
          <Codicon name={ICON[row.severity]} size={14} className="problems-icon" />
          <span className="problems-message" title={row.message}>
            {row.message}
          </span>
          {row.label && <span className="faint problems-label">{row.label}</span>}
          <span className="faint problems-where">{S.problemWhere(row.line, row.column)}</span>
        </button>
      ))}
    </div>
  );
}

const ICON: Record<ProblemSeverity, string> = { error: "error", warning: "warning", info: "info", hint: "lightbulb" };
