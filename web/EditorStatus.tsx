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
  // 에디터 보기가 트랜잭션을 처리할 때마다 올라가는 번호. 값은 안 쓰고 다시 그리는 신호로만 쓴다.
  useSyncExternalStore(subscribeEditorStatus, editorStatusVersion);
  const view = key ? viewFor(key) : null;
  const items = view ? statusItems(view.state, { path }, indentInfoOf(view.state)) : null;
  // GitLens 처럼 커서 줄의 `작성자, 상대시간`. blame 이 없거나 고치는 중이면 항목이 없다.
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

// 누르는 항목
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
