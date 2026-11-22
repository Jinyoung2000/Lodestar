import { Close } from "./icons";
import { openFile, setState, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";

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
