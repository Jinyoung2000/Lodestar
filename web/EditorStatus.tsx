import { useSyncExternalStore } from "react";
import { activeEditorKeyOf } from "./activeEditor";
import { indentInfoOf } from "./editorIndent";
import { pickEndOfLine, pickIndentationAction } from "./editorStatusActions";
import { statusItems, STATUS_TOOLTIPS } from "./editorStatusModel";
import { editorStatusVersion, subscribeEditorStatus } from "./editorStatusState";
import { blameStatus } from "./gitBlame";
import { viewFor } from "./lsp";
import { runCommand } from "./shortcuts";
import { useStore } from "./store";
import "./editorStatus.css";

export function EditorStatus() {
  const key = useStore(activeEditorKeyOf);
  const path = useStore((s) => {
    const tab = s.tabs.find((t) => t.key === key);
    return tab?.kind === "file" ? tab.path : null;
  });
  useSyncExternalStore(subscribeEditorStatus, editorStatusVersion);
  const view = key ? viewFor(key) : null;
  const items = view ? statusItems(view.state, { path }, indentInfoOf(view.state)) : null;
  const blame = view ? blameStatus(view.state) : null;
  return (
    <div className="editor-status" role="toolbar" aria-label="Editor status" data-editor-status>
      {items && (
        <>
          {blame && <StatusText name="blame" text={blame.text} tooltip={blame.title} />}
          <StatusButton name="selection" text={items.selection} tooltip={STATUS_TOOLTIPS.selection} onPress={() => runCommand("gotoLine")} />
          <StatusButton name="indentation" text={items.indentation} tooltip={STATUS_TOOLTIPS.indentation} onPress={() => view && void pickIndentationAction(view)} />
          <StatusText name="encoding" text={items.encoding} tooltip={STATUS_TOOLTIPS.encoding} />
          <StatusButton name="eol" text={items.eol} tooltip={STATUS_TOOLTIPS.eol} onPress={() => view && void pickEndOfLine(view)} />
          <StatusText name="language" text={items.language} tooltip={STATUS_TOOLTIPS.language} />
        </>
      )}
    </div>
  );
}

function StatusButton({ name, text, tooltip, onPress }: { name: string; text: string; tooltip: string; onPress: () => void }) {
  return (
    <button type="button" className="editor-status-item" data-status={name} title={tooltip} onClick={onPress}>
      {text}
    </button>
  );
}

function StatusText({ name, text, tooltip }: { name: string; text: string; tooltip: string }) {
  return (
    <span className="editor-status-item" data-status={name} data-static title={tooltip}>
      {text}
    </span>
  );
}
