import { Close } from "./icons";
import { openFile, setState, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";

// 정의 찾기의 "Find All References" 결과. 세션 오른쪽 패널(Chat 중심)과 왼쪽 사이드바(Editor 중심) 아래에 붙는다. 결과가 없으면 아무것도 그리지 않는다.
export function ReferencesPanel() {
  const references = useStore((s) => s.references);
  if (!references) return null;
  return (
    <div className="references" aria-label={S.references}>
      <div className="pane-header">
        <span className="small">{references.title}</span>
        <span className="spacer" />
        <Button size="icon" aria-label={S.close} onClick={() => setState({ references: null })}>
          <Close />
        </Button>
      </div>
      <div className="references-body">
        {references.groups.map((group) => (
          <div key={`${group.workspaceId}:${group.path}`}>
            <div className="reference-file mono">{group.path}</div>
            {group.hits.map((hit) => (
              <button
                key={`${hit.line}:${hit.column}`}
                type="button"
                className="reference-hit"
                title={S.openToSideAlt}
                onClick={(e) => openFile({ workspaceId: group.workspaceId, path: group.path, line: hit.line, column: hit.column }, { side: e.altKey })}
              >
                <span className="reference-line mono">{hit.line}</span>
                <code className="mono">{hit.text}</code>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
