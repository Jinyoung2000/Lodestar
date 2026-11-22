import { useState } from "react";
import { Codicon, Plus } from "./icons";
import { runCommand } from "./shortcuts";
import { boardShown } from "./screenVisibility";
import { isTopWorkspace, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { useCommandKeycaps } from "./commandKeys";
import { WorkspacePathInput } from "./WorkspacePathInput";
import { canPickFolder, newProjectInNewSession, openFolderInNewSession } from "./folderOpen";

export function EmptyStart() {
  const hasWorkspace = useStore((s) => s.workspaces.some(isTopWorkspace));
  const showBoard = useStore((s) => boardShown(s.settings));
  const [adding, setAdding] = useState(false);

  return (
    <section className="agent empty-start" aria-label={S.emptyStartAria}>
      <div className="empty-start-body">
        <h2 className="empty-start-title">{S.emptyStartTitle}</h2>
        <p className="empty-start-text">{hasWorkspace ? S.emptyStartPickFolder : S.emptyStartAddFolder}</p>
        <div className="empty-start-actions" data-adding={adding || undefined}>
          {adding ? (
            <WorkspacePathInput className="empty-start-input" onCancel={() => setAdding(false)} />
          ) : (
            <>
              <Button variant={hasWorkspace ? "secondary" : "primary"} size="default" onClick={() => (canPickFolder() ? void openFolderInNewSession() : setAdding(true))}>
                <Plus /> {S.addWorkspace}
              </Button>
              <Button variant="secondary" size="default" onClick={() => void newProjectInNewSession()}>
                <Codicon name="new-folder" /> {S.newProjectSide}
              </Button>
            </>
          )}
          {hasWorkspace && (
            <Button variant="primary" size="default" onClick={() => runCommand("newSession")}>
              <Plus /> {S.newSession}
            </Button>
          )}
        </div>
        <ul className="empty-start-keys" aria-label={S.emptyStartKeys}>
          {SHORTCUTS.filter((item) => item.command !== "board" || showBoard).map((item) => (
            <li key={item.command}>
              <span>{item.label}</span>
              <CommandKeycaps command={item.command} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const SHORTCUTS = [
  { label: S.newSession, command: "newSession" },
  { label: S.emptyStartSearch, command: "search" },
  { label: S.emptyStartOpenFile, command: "quickOpen" },
  { label: S.emptyStartTerminal, command: "toggleBottom" },
  { label: S.board, command: "board" },
  { label: S.settings, command: "openSettings" },
];

function CommandKeycaps({ command }: { command: string }) {
  const caps = useCommandKeycaps(command);
  return (
    <span className="keycaps">
      {caps.map((cap, n) => (
        <kbd key={n} className="keycap">
          {cap}
        </kbd>
      ))}
    </span>
  );
}
