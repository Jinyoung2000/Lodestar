import { useState } from "react";
import { Plus } from "./icons";
import { runCommand } from "./shortcuts";
import { boardShown } from "./screenVisibility";
import { isTopWorkspace, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { WorkspacePathInput } from "./WorkspacePathInput";

// 폴더가 하나도 없는 첫 실행 화면(dogfood 16). 무엇을 해야 하는지와 주요 단축키를 알려 주고, 경로를 넣어 첫 폴더를 바로 추가하게 한다.
export function EmptyStart() {
  const hasWorkspace = useStore((s) => s.workspaces.some(isTopWorkspace));
  const showBoard = useStore((s) => boardShown(s.settings));
  const [adding, setAdding] = useState(false);

  return (
    <section className="agent empty-start" aria-label={S.emptyStartAria}>
      <div className="empty-start-body">
        <h2 className="empty-start-title">{S.emptyStartTitle}</h2>
        <p className="empty-start-text">{hasWorkspace ? S.emptyStartPickFolder : S.emptyStartAddFolder}</p>
        <div className="empty-start-actions">
          <Button variant={hasWorkspace ? "secondary" : "primary"} size="default" onClick={() => setAdding((v) => !v)}>
            <Plus /> {S.addWorkspace}
          </Button>
          {hasWorkspace && (
            <Button variant="primary" size="default" onClick={() => runCommand("newSession")}>
              <Plus /> {S.newSession}
            </Button>
          )}
        </div>
        {adding && <WorkspacePathInput className="empty-start-input" onCancel={() => setAdding(false)} />}
        <ul className="empty-start-keys" aria-label={S.emptyStartKeys}>
          {SHORTCUTS.filter((item) => item.label !== S.board || showBoard).map((item) => (
            <li key={item.label}>
              <span>{item.label}</span>
              <span className="keycaps">
                {item.keys.map((key) => (
                  <kbd key={key} className="keycap">
                    {key}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const SHORTCUTS = [
  { label: S.newSession, keys: ["⌘", "N"] },
  { label: S.emptyStartSearch, keys: ["⌘", "K"] },
  { label: S.emptyStartOpenFile, keys: ["⌘", "P"] },
  { label: S.emptyStartTerminal, keys: ["⌘", "J"] },
  { label: S.board, keys: ["⇧", "⌘", "K"] },
  { label: S.settings, keys: ["⌘", ","] },
];
