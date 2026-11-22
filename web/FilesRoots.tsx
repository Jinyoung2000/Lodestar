import { useMemo } from "react";
import type { Agent } from "../shared/protocol";
import { FilesTab } from "./FilesTab";
import { useMissingFolders } from "./missingFolders";
import { removeFolderFromSession, sessionRoots } from "./sessionFolders";
import { useStore } from "./store";

export function FilesRoots({ agent }: { agent: Agent }) {
  const workspaces = useStore((s) => s.workspaces);
  const missingFolders = useMissingFolders();
  const roots = useMemo(() => sessionRoots(agent, workspaces), [agent, workspaces]);
  return (
    <div className="files-roots">
      {roots.map((root, index) => (
        <FilesTab
          key={root.id}
          workspaceId={root.id}
          agentId={root.primary ? agent.id : null}
          root={{ label: root.label, missing: !root.workspace || missingFolders.has(root.id), header: index === 0, onRemove: root.primary ? null : () => void removeFolderFromSession(agent.id, root.id) }}
        />
      ))}
    </div>
  );
}
